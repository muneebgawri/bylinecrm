import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { type INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE, type DomainEvent, type NotificationsView } from '@bylinecrm/shared';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_OPTIONS, configureApp } from '../../src/app';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/infra/prisma.service';
import { EmailEngagementNotificationsConsumer } from '../../src/notifications/email-engagement.consumer';
import { verifyAddress } from '../support/mail';

interface Browser {
    cookie: string;
    csrf: string;
}

function browserFrom(res: Response): Browser {
    const raw = res.headers['set-cookie'] as string[] | undefined;
    const session = raw?.find((c) => c.startsWith(`${SESSION_COOKIE}=`))?.split(';')[0];
    const csrf = raw
        ?.find((c) => c.startsWith(`${CSRF_COOKIE}=`))
        ?.split(';')[0]
        ?.split('=')[1];
    if (!session || !csrf) throw new Error('login did not set both cookies');
    return { cookie: `${session}; ${CSRF_COOKIE}=${csrf}`, csrf };
}

/**
 * A member hears in the bell when someone replies to, clicks a link in or opens an email they sent from the CRM:
 * every reply, a send's first click and first open — unless they turned that kind off. Once the sender has left,
 * the person's owner hears instead. Each member sees only their own, and one workspace never another's.
 */
describe('email engagement notifications: replies, clicks and opens of a member’s sends', () => {
    let app: INestApplication;
    let http: () => request.Agent;
    let owner: PrismaService;
    let consumer: EmailEngagementNotificationsConsumer;
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const password = 'correct horse battery staple';
    const anaEmail = `engage-ana-${stamp}@example.test`;
    const benEmail = `engage-ben-${stamp}@example.test`;
    let admin: Browser;
    let ana: Browser;
    let ben: Browser;
    let other: Browser;
    let workspace: string;
    let otherWorkspace: string;
    let anaId: string;
    let benId: string;
    let person: string;
    let mailbox: string;
    let thread: string;

    const as = (who: Browser) => ({
        get: (path: string) => http().get(path).set('Cookie', who.cookie),
        post: (path: string) => http().post(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
        put: (path: string) => http().put(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
    });
    const w = (path: string, id = workspace) => `/api/w/${id}${path}`;
    const inbox = async (who: Browser, ws = workspace): Promise<NotificationsView> =>
        (await as(who).get(w('/notifications', ws)).expect(200)).body as NotificationsView;
    const engagement = async (who: Browser) => (await inbox(who)).items.filter((n) => n.kind.startsWith('email_'));

    /** A send Ana made from the CRM, to the person. */
    const send = async (subject: string, sender = anaId): Promise<string> => {
        const id = randomUUID();
        await owner.mailOutbound.create({
            data: {
                id,
                workspaceId: workspace,
                mailboxId: mailbox,
                senderMemberId: sender,
                personId: person,
                status: 'sent',
                rfc822MessageId: `<${id}@example.test>`,
                toAddresses: [`pat-${stamp}@example.test`],
                subject,
                mime: `Subject: ${subject}\r\n\r\nHello`,
                providerMessageId: `gmail-${id}`,
                sentAt: new Date(),
            },
        });
        return id;
    };
    /** A reply the person wrote, as sync stores it. */
    const replyMessage = async (subject: string): Promise<string> => {
        const id = randomUUID();
        await owner.mailMessage.create({
            data: {
                id,
                workspaceId: workspace,
                threadId: thread,
                identityKey: `<${id}@example.test>`,
                direction: 'inbound',
                fromAddress: `pat-${stamp}@example.test`,
                sentAt: new Date(),
                subject,
                participants: {
                    create: {
                        workspaceId: workspace,
                        role: 'from',
                        address: `pat-${stamp}@example.test`,
                        displayName: 'Pat Prospect',
                        personId: person,
                    },
                },
            },
        });
        return id;
    };
    const deliver = async (event: DomainEvent) => {
        expect(consumer.accepts(event)).toBe(true);
        await consumer.consume({ id: randomUUID(), event });
    };
    const base = <T extends 'email.replied' | 'email.clicked' | 'email.opened'>(type: T, recordId: string) =>
        ({
            type,
            object: 'email',
            workspaceId: workspace,
            actor: { kind: 'system', id: null },
            occurredAt: new Date().toISOString(),
            recordId,
        }) as const;
    const replied = (outboundId: string, messageId: string): DomainEvent => ({
        ...base('email.replied', messageId),
        reply: {
            messageId,
            inReplyToOutboundId: outboundId,
            inReplyToMessageId: null,
            threadId: thread,
            personIds: [person],
            dealIds: [],
        },
    });
    const tracked = (kind: 'email.clicked' | 'email.opened', outboundId: string, url: string | null): DomainEvent => ({
        ...base(kind, outboundId),
        tracking: {
            outboundId,
            personId: person,
            url,
            sequenceStepId: null,
            enrolmentId: null,
            indicative: kind === 'email.opened',
        },
    });

    beforeAll(async () => {
        const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
        app = configureApp(moduleRef.createNestApplication<NestExpressApplication>(APP_OPTIONS));
        await app.init();
        http = () => request(app.getHttpServer() as Parameters<typeof request>[0]);
        owner = app.get(PrismaService);
        consumer = app.get(EmailEngagementNotificationsConsumer);

        const signUp = async (email: string, name: string) => {
            const res = await http().post('/api/auth/signup').send({ email, password, workspaceName: name });
            expect(res.status).toBe(201);
            await verifyAddress(app, http, email);
            return { browser: browserFrom(res), workspace: (res.body as { workspace: { id: string } }).workspace.id };
        };
        ({ browser: admin, workspace } = await signUp(`engage-admin-${stamp}@example.test`, `Engage ${stamp}`));
        ({ browser: other, workspace: otherWorkspace } = await signUp(
            `engage-other-${stamp}@example.test`,
            `Engage other ${stamp}`,
        ));
        const role = await as(admin)
            .post(w('/roles'))
            .send({ name: 'account manager', capabilities: ['record:read', 'record:write'] })
            .expect(201);
        const join = async (email: string) => {
            const invite = await as(admin)
                .post(w('/invites'))
                .send({ email, roleId: (role.body as { id: string }).id })
                .expect(201);
            const joined = await http()
                .post(`/api/auth/invites/${(invite.body as { token: string }).token}/signup`)
                .send({ password })
                .expect(201);
            await verifyAddress(app, http, email);
            return browserFrom(joined);
        };
        ana = await join(anaEmail);
        ben = await join(benEmail);
        const members = (await as(admin).get(w('/members')).expect(200)).body as { id: string; email: string }[];
        anaId = members.find((m) => m.email === anaEmail)!.id;
        benId = members.find((m) => m.email === benEmail)!.id;
        person = (
            (await as(admin).post(w('/people')).send({ nameFirst: 'Pat', nameLast: 'Prospect' }).expect(201)).body as {
                id: string;
            }
        ).id;
        await owner.person.update({ where: { id: person }, data: { ownerId: benId } });
        mailbox = (
            await owner.mailbox.create({
                data: {
                    workspaceId: workspace,
                    ownerMemberId: anaId,
                    email: `ana-box-${stamp}@example.test`,
                    purpose: 'personal',
                    status: 'connected',
                    refreshTokenCiphertext: 'unused',
                },
            })
        ).id;
        thread = (await owner.mailThread.create({ data: { workspaceId: workspace, lastMessageAt: new Date() } })).id;
    });

    afterAll(async () => {
        await app?.close();
    });

    it('tells the sender of every reply — twice for two — and nobody else', async () => {
        const out = await send(`Quick question ${stamp}`);
        const first = await replyMessage(`Re: Quick question ${stamp}`);
        await deliver(replied(out, first));
        // Delivered again: nothing more.
        await deliver(replied(out, first));
        let mine = await engagement(ana);
        expect(mine).toHaveLength(1);
        expect(mine[0]).toMatchObject({
            kind: 'email_replied',
            target: { type: 'reply', id: first },
            readAt: null,
            email: {
                outboundId: null,
                messageId: first,
                subject: `Re: Quick question ${stamp}`,
                personId: person,
                personName: 'Pat Prospect',
                url: null,
            },
        });
        // A second reply to the same send tells again.
        const second = await replyMessage(`Re: Quick question ${stamp}`);
        await deliver(replied(out, second));
        mine = await engagement(ana);
        expect(mine.filter((n) => n.kind === 'email_replied')).toHaveLength(2);
        expect(await engagement(ben)).toHaveLength(0);
        expect(await engagement(admin)).toHaveLength(0);
        expect((await inbox(other, otherWorkspace)).items).toHaveLength(0);
    });

    it('tells the sender of a send’s first click and first open, once each', async () => {
        const out = await send(`Pricing ${stamp}`);
        await owner.trackingHit.create({
            data: {
                workspaceId: workspace,
                outboundId: out,
                kind: 'click',
                // As SMTP2Go reports one (TRANS-1): no token of ours, its own event id.
                providerEventId: `smtp2go-${out}`,
                url: 'https://example.test/pricing',
                personId: person,
                happenedAt: new Date(),
            },
        });
        await deliver(tracked('email.clicked', out, 'https://example.test/pricing'));
        await deliver(tracked('email.clicked', out, 'https://example.test/other'));
        await deliver(tracked('email.opened', out, null));
        await deliver(tracked('email.opened', out, null));
        const about = (await engagement(ana)).filter((n) => n.target.id === out);
        expect(about.map((n) => n.kind).sort()).toEqual(['email_clicked', 'email_opened']);
        expect(about.find((n) => n.kind === 'email_clicked')).toMatchObject({
            target: { type: 'email', id: out },
            email: {
                outboundId: out,
                messageId: null,
                subject: `Pricing ${stamp}`,
                personId: person,
                personName: 'Pat Prospect',
                url: 'https://example.test/pricing',
            },
        });
        expect(about.find((n) => n.kind === 'email_opened')?.email?.url).toBeNull();
    });

    it('tells nobody of a kind the sender turned off; the others still tell', async () => {
        const set = await as(ana).put(w('/notification-settings')).send({ notifyEmailOpens: false }).expect(200);
        expect(set.body).toEqual({
            taskDigest: true,
            notifyEmailReplies: true,
            notifyEmailClicks: true,
            notifyEmailOpens: false,
        });
        const out = await send(`Opens off ${stamp}`);
        await deliver(tracked('email.opened', out, null));
        await deliver(tracked('email.clicked', out, null));
        const about = (await engagement(ana)).filter((n) => n.target.id === out);
        expect(about.map((n) => n.kind)).toEqual(['email_clicked']);
        // Partial updates leave the rest alone.
        await as(ana).put(w('/notification-settings')).send({ notifyEmailReplies: false }).expect(200);
        expect((await as(ana).get(w('/notification-settings')).expect(200)).body).toEqual({
            taskDigest: true,
            notifyEmailReplies: false,
            notifyEmailClicks: true,
            notifyEmailOpens: false,
        });
        const reply = await replyMessage(`Re: Opens off ${stamp}`);
        await deliver(replied(out, reply));
        expect((await engagement(ana)).some((n) => n.target.id === reply)).toBe(false);
        await as(ana)
            .put(w('/notification-settings'))
            .send({ notifyEmailReplies: true, notifyEmailOpens: true })
            .expect(200);
    });

    it('tells the person’s owner once the sender has left; nobody when neither is in the workspace', async () => {
        const out = await send(`Left ${stamp}`);
        await owner.workspaceMember.update({ where: { id: anaId }, data: { leftAt: new Date() } });
        try {
            const reply = await replyMessage(`Re: Left ${stamp}`);
            await deliver(replied(out, reply));
            expect((await engagement(ben)).map((n) => n.target)).toEqual([{ type: 'reply', id: reply }]);
            // Neither in the workspace: nobody.
            await owner.workspaceMember.update({ where: { id: benId }, data: { leftAt: new Date() } });
            const again = await replyMessage(`Re: Left ${stamp}`);
            await deliver(replied(out, again));
            expect(await owner.notification.count({ where: { mailMessageId: again } })).toBe(0);
        } finally {
            await owner.workspaceMember.updateMany({
                where: { id: { in: [anaId, benId] } },
                data: { leftAt: null },
            });
        }
    });

    it('a test send tells nobody', async () => {
        const out = await send(`Test ${stamp}`);
        await owner.mailOutbound.update({ where: { id: out }, data: { isTest: true } });
        await deliver(tracked('email.opened', out, null));
        expect(await owner.notification.count({ where: { mailOutboundId: out } })).toBe(0);
    });
});

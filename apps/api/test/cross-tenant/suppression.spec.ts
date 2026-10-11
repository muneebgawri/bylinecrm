import 'reflect-metadata';
import { type INestApplication } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { CSRF_COOKIE, CSRF_HEADER, GMAIL_SCOPES, SESSION_COOKIE, SYSTEM_ROLES, type RichText } from '@bylinecrm/shared';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_OPTIONS, configureApp } from '../../src/app';
import { AppModule } from '../../src/app.module';
import { RateLimiter } from '../../src/auth/rate-limiter.service';
import { ENV, type Env } from '../../src/config/env';
import { PrismaService } from '../../src/infra/prisma.service';
import { GOOGLE_OAUTH_PORT } from '../../src/mail-accounts/google-oauth.port';
import { MAIL_OAUTH_CALLBACK_PATH } from '../../src/mail-accounts/mail-accounts.constants';
import { MailSendService } from '../../src/mail-send/mail-send.service';
import { buildMime, newMessageId } from '../../src/mail-send/mime';
import { GMAIL_RETRY_ATTEMPTS } from '../../src/mail-sync/mail-sync.constants';
import { GMAIL_PORT } from '../../src/mail-sync/gmail.port';
import { SuppressionService } from '../../src/suppression/suppression.service';
import { UNSUBSCRIBE_RATE_LIMIT, unsubscribeRateKey } from '../../src/suppression/suppression.constants';
import { UnsubscribeService } from '../../src/suppression/unsubscribe.service';
import { withUnsubscribeUrl } from '../../src/templates/render/compose';
import { FakeGmail } from '../support/fake-gmail';
import { FakeGoogleOAuth } from '../support/fake-google-oauth';

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

interface Suppression {
    id: string;
    address: string;
    reason: string;
    source: string;
    personId: string | null;
    note: string | null;
    liftable: boolean;
}
interface ApiError {
    code: string;
    message: string;
    fieldErrors?: { path: string; message: string }[];
}
interface BusEvent {
    type: string;
    workspaceId: string;
    recordId: string;
    suppression?: { address: string; reason: string; source: string; personId: string | null };
}

const body = (...content: object[]): RichText => ({ type: 'doc', content }) as RichText;
const para = (...content: object[]) => ({ type: 'paragraph', content });
const t = (text: string) => ({ type: 'text', text });
const v = (path: string) => ({ type: 'variable', attrs: { path } });
const header = (raw: string, name: string): string | undefined =>
    raw
        .split('\r\n\r\n')[0]!
        .replace(/\r\n[ \t]+/g, ' ')
        .split('\r\n')
        .find((l) => l.toLowerCase().startsWith(`${name.toLowerCase()}:`))
        ?.slice(name.length + 1)
        .trim();
const htmlPart = (raw: string): string =>
    Buffer.from(
        raw
            .split(/Content-Type: text\/html[^\r\n]*\r\n[^\r\n]*\r\n\r\n/)[1]!
            .split('\r\n--')[0]!
            .replace(/\r\n/g, ''),
        'base64',
    ).toString('utf8');

/**
 * Suppression and one-click unsubscribe (P3-1, FR-CRMS-7) end to end: the workspace's list, the one
 * check every send passes — at the request, at a scheduled send's time and before every delivery
 * attempt — the RFC 8058 headers and visible link on outreach mail, and the public endpoint a
 * recipient's mail client calls. A token unsubscribes its own address in its own workspace only, a GET
 * never unsubscribes, and one workspace never reads or changes another's list.
 */
describe('FR-CRMS-7 suppression and unsubscribe', () => {
    let app: INestApplication;
    let http: () => request.Agent;
    let owner: PrismaService;
    let send: MailSendService;
    let suppressions: SuppressionService;
    let unsubscribe: UnsubscribeService;
    let env: Env;
    const google = new FakeGoogleOAuth();
    const gmail = new FakeGmail(google);

    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const password = 'correct horse battery staple';
    let admin: Browser;
    let member: Browser;
    let otherAdmin: Browser;
    let workspace: string;
    let otherWorkspace: string;
    const adminEmail = `supp-admin-${stamp}@example.com`;
    const memberEmail = `supp-member-${stamp}@example.com`;
    const otherEmail = `supp-other-${stamp}@example.com`;
    let adminMailbox: string;

    const events: BusEvent[] = [];
    const as = (who: Browser) => ({
        get: (path: string) => http().get(path).set('Cookie', who.cookie),
        post: (path: string) => http().post(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
        put: (path: string) => http().put(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
    });
    const w = (path: string, id = workspace) => `/api/w/${id}${path}`;
    const noWait = { sleep: () => Promise.resolve() };
    const err = (res: Response) => res.body as ApiError;
    const inMs = (ms: number) => new Date(Date.now() + ms).toISOString();

    /** A person with their own address, so each test suppresses someone no other test mails. */
    async function person(tag: string, ws = workspace, who: Browser = admin): Promise<{ id: string; address: string }> {
        const address = `${tag}-${stamp}@acme.example`;
        const res = await as(who)
            .post(w('/people', ws))
            .send({ nameFirst: 'Dana', nameLast: tag, emails: { primary: address, additional: [] } });
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        return { id: (res.body as { id: string }).id, address };
    }

    async function list(who: Browser = admin, ws = workspace, query = ''): Promise<Suppression[]> {
        const res = await as(who).get(w(`/suppressions${query}`, ws));
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        return (res.body as { items: Suppression[] }).items;
    }

    const sendTo = (personId: string, extra: Record<string, unknown> = {}) =>
        as(admin)
            .post(w('/mail/send'))
            .send({
                mailboxId: adminMailbox,
                personId,
                subject: 'Following up',
                body: body(para(t('Hi '), v('person.firstName'), t('.'))),
                ...extra,
            });

    async function outboundError(id: string): Promise<{ status: string; error: ApiError | null }> {
        const res = await as(admin).get(w(`/mail/messages/${id}`));
        return res.body as { status: string; error: ApiError | null };
    }

    beforeAll(async () => {
        const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
            .overrideProvider(GOOGLE_OAUTH_PORT)
            .useValue(google)
            .overrideProvider(GMAIL_PORT)
            .useValue(gmail)
            .compile();
        app = configureApp(moduleRef.createNestApplication<NestExpressApplication>(APP_OPTIONS));
        await app.init();
        http = () => request(app.getHttpServer() as Parameters<typeof request>[0]);
        owner = app.get(PrismaService);
        send = app.get(MailSendService);
        suppressions = app.get(SuppressionService);
        unsubscribe = app.get(UnsubscribeService);
        env = app.get<Env>(ENV);
        app.get(EventEmitter2).onAny((type: string | string[], payload: unknown) => {
            if (typeof type === 'string' && type.startsWith('suppression.')) events.push(payload as BusEvent);
        });

        const signUp = async (email: string, name: string) => {
            const res = await http().post('/api/auth/signup').send({ email, password, workspaceName: name });
            expect(res.status).toBe(201);
            return { browser: browserFrom(res), workspace: (res.body as { workspace: { id: string } }).workspace.id };
        };
        ({ browser: admin, workspace } = await signUp(adminEmail, `Suppression ${stamp}`));
        ({ browser: otherAdmin, workspace: otherWorkspace } = await signUp(otherEmail, `Other suppression ${stamp}`));

        const roles = await as(admin).get(w('/roles'));
        const memberRoleId = (roles.body as { id: string; name: string }[]).find(
            (r) => r.name === SYSTEM_ROLES.member,
        )!.id;
        const invite = await as(admin).post(w('/invites')).send({ email: memberEmail, roleId: memberRoleId });
        const joined = await http()
            .post(`/api/auth/invites/${(invite.body as { token: string }).token}/signup`)
            .send({ password });
        expect(joined.status).toBe(201);
        member = browserFrom(joined);

        const clientId = `555-a${stamp.replace(/[^a-z0-9]/g, '')}.apps.googleusercontent.com`;
        const secret = `GOCSPX-supp-${stamp}`;
        const view = await as(admin).get(w('/mail/oauth-client'));
        google.registerClient(clientId, secret, [(view.body as { redirectUri: string }).redirectUri]);
        await as(admin).put(w('/mail/oauth-client')).send({ clientId, clientSecret: secret }).expect(200);
        const start = await as(admin).post(w('/mailboxes/connect')).send({ purpose: 'personal' });
        expect(start.status).toBe(201);
        const { code, state } = google.consent((start.body as { authorizeUrl: string }).authorizeUrl, {
            email: adminEmail,
            scopes: [...GMAIL_SCOPES],
        });
        await as(admin).get(`${MAIL_OAUTH_CALLBACK_PATH}?state=${state}&code=${code}`);
        const mailboxes = (await as(admin).get(w('/mailboxes'))).body as { id: string; email: string }[];
        adminMailbox = mailboxes.find((m) => m.email === adminEmail)!.id;

        // Outreach renders need the postal address the footer carries (FR-CRMS-12).
        await as(admin)
            .put(w('/settings/mail'))
            .send({
                postalAddress: {
                    line1: '123 Main St',
                    line2: null,
                    city: 'Austin',
                    region: 'TX',
                    postalCode: '78701',
                    country: 'US',
                },
                defaultSenderName: null,
                unsubscribeFooterText: 'You are receiving this because we thought it would interest you.',
            })
            .expect(200);
    });

    afterAll(async () => {
        await app?.close();
    });

    describe('FR-CRMS-7 the workspace’s list', () => {
        it('adds an address as a manual entry, lower case, and lists it', async () => {
            const res = await as(admin)
                .post(w('/suppressions'))
                .send({ address: `  Manual-${stamp}@Example.COM `, note: 'asked us on the phone' });
            expect(res.status, JSON.stringify(res.body)).toBe(201);
            const entry = res.body as Suppression;
            expect(entry).toMatchObject({
                address: `manual-${stamp}@example.com`,
                reason: 'manual',
                source: 'member',
                note: 'asked us on the phone',
                liftable: true,
            });
            expect((await list()).map((s) => s.id)).toContain(entry.id);
            expect(events.filter((e) => e.type === 'suppression.added' && e.recordId === entry.id)).toHaveLength(1);
        });

        it('refuses an address already on the list, naming address', async () => {
            const address = `twice-${stamp}@example.com`;
            await as(admin).post(w('/suppressions')).send({ address }).expect(201);
            const again = await as(admin).post(w('/suppressions')).send({ address });
            expect(again.status).toBe(409);
            expect(err(again).code).toBe('conflict.unique');
            expect(err(again).fieldErrors?.[0]?.path).toBe('address');
        });

        it('refuses something that is not an address, naming address', async () => {
            const res = await as(admin).post(w('/suppressions')).send({ address: 'not an address' });
            expect(res.status).toBe(400);
            expect(err(res).fieldErrors?.[0]?.path).toBe('address');
        });

        it('searches by address and filters by reason', async () => {
            const address = `findme-${stamp}@example.com`;
            await as(admin).post(w('/suppressions')).send({ address }).expect(201);
            expect((await list(admin, workspace, `?q=findme-${stamp}`)).map((s) => s.address)).toEqual([address]);
            expect(await list(admin, workspace, `?q=findme-${stamp}&reason=unsubscribe`)).toEqual([]);
        });

        it('lets an admin lift a manual entry with a note; the entry keeps its history and the address may be mailed', async () => {
            const dana = await person('lifted');
            const added = (await as(admin).post(w('/suppressions')).send({ address: dana.address }))
                .body as Suppression;
            const lifted = await as(admin)
                .post(w(`/suppressions/${added.id}/remove`))
                .send({ note: 'added by mistake' });
            expect(lifted.status, JSON.stringify(lifted.body)).toBe(204);
            expect((await list()).map((s) => s.id)).not.toContain(added.id);
            const row = await owner.suppression.findUniqueOrThrow({ where: { id: added.id } });
            expect(row.removedAt).not.toBeNull();
            expect(row.removalNote).toBe('added by mistake');
            expect((await sendTo(dana.id)).status).toBe(202);
            expect(events.filter((e) => e.type === 'suppression.removed' && e.recordId === added.id)).toHaveLength(1);
            // Suppressed again later: a new live entry, the old one stays on record.
            await as(admin).post(w('/suppressions')).send({ address: dana.address }).expect(201);
        });

        it('requires a note to lift an entry', async () => {
            const added = (
                await as(admin)
                    .post(w('/suppressions'))
                    .send({ address: `nonote-${stamp}@example.com` })
            ).body as Suppression;
            const res = await as(admin)
                .post(w(`/suppressions/${added.id}/remove`))
                .send({});
            expect(res.status).toBe(400);
            expect(err(res).fieldErrors?.[0]?.path).toBe('note');
        });

        it('never lifts an unsubscribe or a complaint: only the person can undo their own choice', async () => {
            for (const reason of ['unsubscribe', 'complaint'] as const) {
                const entry = await suppressions.suppress(workspace, {
                    address: `${reason}-kept-${stamp}@example.com`,
                    reason,
                    source: reason === 'complaint' ? 'provider' : 'recipient',
                });
                const listed = (await list(admin, workspace, `?q=${reason}-kept-${stamp}`))[0]!;
                expect(listed.liftable).toBe(false);
                const res = await as(admin)
                    .post(w(`/suppressions/${entry.id}/remove`))
                    .send({ note: 'please' });
                expect(res.status).toBe(409);
                expect(err(res).code).toBe('conflict');
            }
        });

        it('lets the person’s own unsubscribe replace a liftable entry, so lifting a bounce cannot undo it', async () => {
            const address = `bounced-then-unsubscribed-${stamp}@example.com`;
            const bounce = await suppressions.suppress(workspace, {
                address,
                reason: 'hard_bounce',
                source: 'provider',
            });
            const unsub = await suppressions.suppress(workspace, {
                address,
                reason: 'unsubscribe',
                source: 'recipient',
            });
            expect(unsub.id).not.toBe(bounce.id);
            expect(unsub).toMatchObject({ reason: 'unsubscribe', liftable: false });
            const old = await owner.suppression.findUniqueOrThrow({ where: { id: bounce.id } });
            expect(old.removedAt).not.toBeNull();
            expect(old.removalNote).toBe('replaced by the person unsubscribing');
            expect((await suppressions.check(workspace, [address])).get(address)?.reason).toBe('unsubscribe');
            // A weaker reason after it changes nothing.
            const again = await suppressions.suppress(workspace, {
                address,
                reason: 'hard_bounce',
                source: 'provider',
            });
            expect(again.id).toBe(unsub.id);
        });

        it('lets a member without outreach rights neither read nor change the list; lifting needs an admin', async () => {
            expect((await as(member).get(w('/suppressions'))).status).toBe(403);
            expect(
                (
                    await as(member)
                        .post(w('/suppressions'))
                        .send({ address: `m-${stamp}@example.com` })
                ).status,
            ).toBe(403);
            const added = (
                await as(admin)
                    .post(w('/suppressions'))
                    .send({ address: `m2-${stamp}@example.com` })
            ).body as Suppression;
            expect(
                (
                    await as(member)
                        .post(w(`/suppressions/${added.id}/remove`))
                        .send({ note: 'x' })
                ).status,
            ).toBe(403);
        });
    });

    describe('FR-CRMS-7 one workspace’s list is its own', () => {
        it('never shows, lifts or is changed by another workspace', async () => {
            const address = `shared-${stamp}@example.com`;
            const mine = (await as(admin).post(w('/suppressions')).send({ address })).body as Suppression;
            expect((await list(otherAdmin, otherWorkspace)).map((s) => s.address)).not.toContain(address);
            // The other workspace may suppress the same address in its own list.
            await as(otherAdmin).post(w('/suppressions', otherWorkspace)).send({ address }).expect(201);
            // …and cannot reach this workspace's entry, by its own route or this one's.
            expect(
                (
                    await as(otherAdmin)
                        .post(w(`/suppressions/${mine.id}/remove`, otherWorkspace))
                        .send({ note: 'x' })
                ).status,
            ).toBe(404);
            expect(
                (
                    await as(otherAdmin)
                        .post(w(`/suppressions/${mine.id}/remove`))
                        .send({ note: 'x' })
                ).status,
            ).toBe(403);
            expect((await list()).map((s) => s.id)).toContain(mine.id);
        });

        it('does not stop another workspace from mailing an address this one suppressed', async () => {
            const address = `only-here-${stamp}@example.com`;
            await suppressions.suppress(workspace, { address, reason: 'unsubscribe', source: 'recipient' });
            expect((await suppressions.check(otherWorkspace, [address])).size).toBe(0);
            expect((await suppressions.check(workspace, [address])).get(address)?.reason).toBe('unsubscribe');
        });
    });

    describe('FR-CRMS-7 every send is checked', () => {
        it('refuses a send to a suppressed address at the request, naming the field and the reason', async () => {
            const dana = await person('refused');
            await suppressions.suppress(workspace, {
                address: dana.address,
                reason: 'hard_bounce',
                source: 'provider',
            });
            const res = await sendTo(dana.id);
            expect(res.status).toBe(422);
            expect(err(res).code).toBe('recipient.suppressed');
            expect(err(res).fieldErrors).toEqual([{ path: 'to', message: `${dana.address}: hard bounce` }]);
        });

        it('refuses the whole send when a cc is suppressed, naming cc', async () => {
            const dana = await person('cc-ok');
            const cc = `cc-suppressed-${stamp}@example.com`;
            await suppressions.suppress(workspace, { address: cc, reason: 'unsubscribe', source: 'recipient' });
            const res = await sendTo(dana.id, { cc: [{ address: cc }] });
            expect(res.status).toBe(422);
            expect(err(res).fieldErrors).toEqual([{ path: 'cc', message: `${cc}: unsubscribed` }]);
        });

        it('fails a scheduled send at its time when the address was suppressed meanwhile', async () => {
            const dana = await person('scheduled');
            const res = await sendTo(dana.id, { sendAt: inMs(60 * 60 * 1000) });
            expect(res.status, JSON.stringify(res.body)).toBe(202);
            const { messageId } = res.body as { messageId: string };
            await suppressions.suppress(workspace, {
                address: dana.address,
                reason: 'unsubscribe',
                source: 'recipient',
            });
            const row = await owner.mailOutbound.findUniqueOrThrow({ where: { id: messageId } });
            const sentBefore = gmail.sent.length;
            const outcome = await send.deliver(workspace, messageId, noWait, row.sendAt!.getTime() + 1_000);
            expect(outcome).toBe('failed');
            expect(gmail.sent.length).toBe(sentBefore);
            expect((await outboundError(messageId)).error?.code).toBe('recipient.suppressed');
        });

        it('does not send a queued message whose address was suppressed before its job ran', async () => {
            const dana = await person('queued');
            const res = await sendTo(dana.id);
            expect(res.status).toBe(202);
            const { messageId } = res.body as { messageId: string };
            await suppressions.suppress(workspace, { address: dana.address, reason: 'complaint', source: 'provider' });
            const sentBefore = gmail.sent.length;
            expect(await send.deliver(workspace, messageId, noWait)).toBe('failed');
            expect(gmail.sent.length).toBe(sentBefore);
            const outbound = await outboundError(messageId);
            expect(outbound.status).toBe('failed');
            expect(outbound.error?.code).toBe('recipient.suppressed');
        });

        it('does not retry a send to an address suppressed between attempts', async () => {
            const dana = await person('retried');
            const res = await sendTo(dana.id);
            const { messageId } = res.body as { messageId: string };
            gmail.failNext(adminEmail, 'send', 503, GMAIL_RETRY_ATTEMPTS);
            await expect(send.deliver(workspace, messageId, noWait)).rejects.toThrow();
            expect((await outboundError(messageId)).status).toBe('sending');
            await suppressions.suppress(workspace, {
                address: dana.address,
                reason: 'unsubscribe',
                source: 'recipient',
            });
            const sentBefore = gmail.sent.length;
            expect(await send.deliver(workspace, messageId, noWait)).toBe('failed');
            expect(gmail.sent.length).toBe(sentBefore);
            expect((await outboundError(messageId)).error?.code).toBe('recipient.suppressed');
        });
    });

    describe('FR-CRMS-7 outreach mail carries one-click unsubscribe; personal mail does not', () => {
        it('puts List-Unsubscribe, List-Unsubscribe-Post and the visible link on an outreach message', async () => {
            const dana = await person('outreach');
            const template = await as(admin)
                .post(w('/templates'))
                .send({ name: `Outreach ${stamp}`, kind: 'outreach', subject: 'Hello', body: body(para(t('Hi.'))) });
            expect(template.status, JSON.stringify(template.body)).toBe(201);
            const preview = await as(admin)
                .post(w(`/templates/${(template.body as { id: string }).id}/preview`))
                .send({ personId: dana.id });
            expect(preview.status).toBe(200);
            const rendered = preview.body as { subject: string; html: string; text: string };

            const link = await unsubscribe.issue(workspace, {
                address: dana.address,
                personId: dana.id,
                outboundId: null,
            });
            expect(link.oneClickUrl).toBe(`${env.APP_URL}/api/unsubscribe/${link.token}`);
            expect(link.pageUrl).toBe(`${env.WEB_URL}/unsubscribe/${link.token}`);
            const email = withUnsubscribeUrl(rendered, link.pageUrl);
            const raw = buildMime({
                from: { address: `pool-${stamp}@example.com` },
                to: [{ address: dana.address }],
                subject: rendered.subject,
                text: email.text,
                html: email.html,
                messageId: newMessageId(),
                crmId: '00000000-0000-4000-8000-000000000000',
                listUnsubscribe: { url: link.oneClickUrl },
                date: new Date(),
            });
            expect(header(raw, 'List-Unsubscribe')).toBe(`<${link.oneClickUrl}>`);
            expect(header(raw, 'List-Unsubscribe-Post')).toBe('List-Unsubscribe=One-Click');
            expect(htmlPart(raw)).toContain(`<a href="${link.pageUrl}">Unsubscribe</a>`);
            expect(email.text).toContain(link.pageUrl);
            expect(email.html).not.toContain('{{unsubscribe_url}}');

            // The header's URL is what a mail client POSTs to: it unsubscribes Dana here.
            const posted = await http()
                .post(new URL(link.oneClickUrl).pathname)
                .type('form')
                .send('List-Unsubscribe=One-Click');
            expect(posted.status).toBe(200);
            expect((await sendTo(dana.id)).status).toBe(422);
        });

        it('sends personal 1:1 mail without unsubscribe headers or link', async () => {
            const dana = await person('personal');
            const res = await sendTo(dana.id);
            const { messageId } = res.body as { messageId: string };
            await send.deliver(workspace, messageId, noWait);
            const raw = gmail.sent.find((s) => s.raw.includes(messageId))!.raw;
            expect(header(raw, 'List-Unsubscribe')).toBeUndefined();
            expect(header(raw, 'List-Unsubscribe-Post')).toBeUndefined();
            expect(htmlPart(raw)).not.toContain('nsubscribe');
        });
    });

    describe('FR-CRMS-7 the one-click endpoint', () => {
        it('unsubscribes once: the address is suppressed in the token’s workspace, announced once, and a second POST changes nothing', async () => {
            const dana = await person('oneclick');
            const link = await unsubscribe.issue(workspace, {
                address: dana.address,
                personId: dana.id,
                outboundId: null,
            });
            const path = `/api/unsubscribe/${link.token}`;
            const first = await http().post(path).type('form').send('List-Unsubscribe=One-Click');
            expect(first.status).toBe(200);
            expect(first.body).toEqual({ recipient: expect.stringMatching(/^o•+@acme\.example$/), unsubscribed: true });
            const second = await http().post(path).type('form').send('List-Unsubscribe=One-Click');
            expect(second.status).toBe(200);
            expect(second.body).toEqual(first.body);

            const entries = await owner.suppression.findMany({
                where: { workspaceId: workspace, address: dana.address },
            });
            expect(entries).toHaveLength(1);
            expect(entries[0]).toMatchObject({ reason: 'unsubscribe', source: 'recipient', personId: dana.id });
            const announced = events.filter(
                (e) => e.type === 'suppression.added' && e.suppression?.address === dana.address,
            );
            expect(announced).toHaveLength(1);
            expect(announced[0]!.suppression).toMatchObject({ reason: 'unsubscribe', source: 'recipient' });
        });

        it('accepts the one-click POST as multipart, or with no body at all', async () => {
            for (const tag of ['multipart', 'nobody']) {
                const dana = await person(tag);
                const link = await unsubscribe.issue(workspace, {
                    address: dana.address,
                    personId: null,
                    outboundId: null,
                });
                const req = http().post(`/api/unsubscribe/${link.token}`);
                const res = tag === 'multipart' ? await req.field('List-Unsubscribe', 'One-Click') : await req;
                expect(res.status, tag).toBe(200);
                expect((await suppressions.check(workspace, [dana.address])).has(dana.address)).toBe(true);
            }
        });

        it('never unsubscribes on a GET: it leads to the confirmation page, and the status reads not unsubscribed', async () => {
            const dana = await person('prefetch');
            const link = await unsubscribe.issue(workspace, {
                address: dana.address,
                personId: dana.id,
                outboundId: null,
            });
            const get = await http().get(`/api/unsubscribe/${link.token}`);
            expect(get.status).toBe(303);
            expect(get.headers['location']).toBe(link.pageUrl);
            const status = await http().get(`/api/unsubscribe/${link.token}/status`);
            expect(status.status).toBe(200);
            expect(status.body).toEqual({
                recipient: expect.stringMatching(/^p•+@acme\.example$/),
                unsubscribed: false,
            });
            expect((await suppressions.check(workspace, [dana.address])).size).toBe(0);
        });

        it('answers 404 to a token that does not exist or was changed, on every route', async () => {
            const dana = await person('tampered');
            const link = await unsubscribe.issue(workspace, {
                address: dana.address,
                personId: null,
                outboundId: null,
            });
            const last = link.token.slice(-1);
            const tampered = `${link.token.slice(0, -1)}${last === 'A' ? 'B' : 'A'}`;
            for (const token of [tampered, 'nope']) {
                expect((await http().post(`/api/unsubscribe/${token}`)).status).toBe(404);
                expect((await http().get(`/api/unsubscribe/${token}`)).status).toBe(404);
                expect((await http().get(`/api/unsubscribe/${token}/status`)).status).toBe(404);
            }
            expect((await suppressions.check(workspace, [dana.address])).size).toBe(0);
        });

        it('suppresses in the token’s own workspace only, whatever session calls it', async () => {
            const address = `crossws-${stamp}@acme.example`;
            const link = await unsubscribe.issue(otherWorkspace, { address, personId: null, outboundId: null });
            // Called with this workspace's admin session: the workspace still comes from the token.
            const res = await as(admin).post(`/api/unsubscribe/${link.token}`);
            expect(res.status).toBe(200);
            expect((await suppressions.check(otherWorkspace, [address])).has(address)).toBe(true);
            expect((await suppressions.check(workspace, [address])).has(address)).toBe(false);
        });

        it('stores only the token’s hash and reveals no id in it', async () => {
            const dana = await person('hashed');
            const link = await unsubscribe.issue(workspace, {
                address: dana.address,
                personId: dana.id,
                outboundId: null,
            });
            const rows = await owner.unsubscribeToken.findMany({
                where: { workspaceId: workspace, address: dana.address },
            });
            expect(rows).toHaveLength(1);
            expect(rows[0]!.tokenHash).not.toContain(link.token);
            expect(JSON.stringify(rows[0])).not.toContain(link.token);
            for (const id of [workspace, dana.id]) expect(link.token).not.toContain(id.replace(/-/g, ''));
            expect(link.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
        });

        it('rate-limits the public routes per client', async () => {
            const limiter = app.get(RateLimiter);
            const key = unsubscribeRateKey('::ffff:127.0.0.1');
            await limiter.clear(key);
            try {
                let limited: Response | undefined;
                for (let i = 0; i <= UNSUBSCRIBE_RATE_LIMIT; i++) {
                    const res = await http().get('/api/unsubscribe/not-a-token/status');
                    if (res.status === 429) {
                        limited = res;
                        break;
                    }
                }
                expect(limited?.status).toBe(429);
                expect(err(limited!).code).toBe('rate_limited');
            } finally {
                await limiter.clear(key);
            }
        });
    });
});

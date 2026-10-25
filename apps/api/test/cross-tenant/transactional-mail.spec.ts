import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE, SYSTEM_ROLES } from '@bylinecrm/shared';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../../src/app.module';
import { APP_OPTIONS, configureApp, createApp } from '../../src/app';
import { RESET_REQUEST_ADDRESS_MAX, RESET_REQUEST_IP_MAX } from '../../src/auth/auth.constants';
import { hashToken } from '../../src/auth/tokens';
import { PrismaService } from '../../src/infra/prisma.service';
import { RlsPrismaService } from '../../src/infra/rls-prisma.service';
import { TransactionAcrossNetworkError, transactionOpen } from '../../src/infra/transaction-scope';
import { memoryOutbox } from '../../src/transactional-mail/memory.transport';
import { MailOutbox } from '../../src/transactional-mail/mail-outbox';
import { MailOutboxRelay } from '../../src/transactional-mail/mail-outbox-relay';
import { MAIL_OUTBOX_LEASE_MS } from '../../src/transactional-mail/transactional-mail.constants';
import {
    TRANSACTIONAL_MAIL_TRANSPORT,
    type OutgoingMail,
    type TransactionalMailTransport,
} from '../../src/transactional-mail/transport.port';
import { deliverMail, lastMailTo, mailTo, tokenIn } from '../support/mail';

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
    if (!session || !csrf) throw new Error('response did not set both cookies');
    return { cookie: `${session}; ${CSRF_COOKIE}=${csrf}`, csrf };
}

/**
 * A transport that behaves like Resend when the answer is lost: the first request for a key is
 * accepted (and delivered) but the caller sees a network error; a retry with the same key is
 * recognised and not sent again. It records into the same outbox the memory transport uses.
 */
class LostAnswerTransport implements TransactionalMailTransport {
    private readonly seen = new Set<string>();
    private loseNext = false;
    readonly calls: { key: string; insideTransaction: boolean }[] = [];

    loseNextAnswer(): void {
        this.loseNext = true;
    }

    async send(mail: OutgoingMail): Promise<{ id: string }> {
        this.calls.push({ key: mail.idempotencyKey, insideTransaction: transactionOpen() });
        if (transactionOpen()) throw new TransactionAcrossNetworkError('test transport');
        if (!this.seen.has(mail.idempotencyKey)) {
            this.seen.add(mail.idempotencyKey);
            memoryOutbox.record(mail);
        }
        if (this.loseNext) {
            this.loseNext = false;
            throw new Error('socket hang up');
        }
        return Promise.resolve({ id: mail.idempotencyKey });
    }
}

/**
 * #93 (D-246, doc 48 §6.1): transactional mail end to end against the real application — the
 * verification link, the unverified gate on tenant routes, password reset, and invitations by
 * mail. Mail goes through the real outbox and relay into a transport the test controls; nothing is sent.
 */
describe('#93 transactional mail', () => {
    let app: INestApplication;
    let http: () => request.Agent;
    let transport: LostAnswerTransport;
    let withWorkspace: ReturnType<typeof vi.spyOn>;
    let owner: PrismaService;
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const emailA = `mail-a-${stamp}@example.test`;
    const emailB = `mail-b-${stamp}@example.test`;
    const password = 'correct horse battery staple';
    let a: Browser;
    let workspaceA: string;

    beforeAll(async () => {
        transport = new LostAnswerTransport();
        const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
            .overrideProvider(TRANSACTIONAL_MAIL_TRANSPORT)
            .useValue(transport)
            .compile();
        app = configureApp(moduleRef.createNestApplication<NestExpressApplication>(APP_OPTIONS));
        await app.init();
        http = () => request(app.getHttpServer() as Parameters<typeof request>[0]);
        withWorkspace = vi.spyOn(app.get(RlsPrismaService), 'withWorkspace');
        owner = app.get(PrismaService);
        // Mail another spec left recorded goes out now, so this spec's counts are its own.
        await deliverMail(app);

        const signup = await http()
            .post('/api/auth/signup')
            .send({ email: emailA, password, workspaceName: 'Mail Alpha' })
            .expect(201);
        a = browserFrom(signup);
        workspaceA = (signup.body as { workspace: { id: string } }).workspace.id;
        await http().post('/api/auth/signup').send({ email: emailB, password, workspaceName: 'Mail Beta' }).expect(201);
    });

    afterAll(async () => {
        await app.close();
    });

    describe('verification', () => {
        it('#93: sign-up mails exactly one verification link, from the configured sender, with no tracking', async () => {
            await deliverMail(app);
            const sent = mailTo(emailA, 'email_verification');
            expect(sent).toHaveLength(1);
            const mail = sent[0]!;
            expect(mail.from).toMatch(/BylineCRM/);
            expect(mail.subject).toMatch(/verify/i);
            expect(mail.text).toMatch(/\/verify-email\?token=/);
            expect(mail.html).not.toMatch(/<img/i);
            expect(mail.html).toContain(tokenIn(mail));
        });

        it('#93: an unverified member is refused on tenant routes before any workspace-scoped query', async () => {
            withWorkspace.mockClear();
            const res = await http().get(`/api/w/${workspaceA}/roles`).set('Cookie', a.cookie).expect(403);
            expect(res.body).toMatchObject({ code: 'email.unverified' });
            expect(withWorkspace).not.toHaveBeenCalled();
            // Who they are, and the way out, still answer.
            await http().get('/api/me').set('Cookie', a.cookie).expect(200);
        });

        it('#93: an unverified person cannot create a workspace', async () => {
            const res = await http()
                .post('/api/workspaces')
                .set('Cookie', a.cookie)
                .set(CSRF_HEADER, a.csrf)
                .send({ name: 'Second' })
                .expect(403);
            expect(res.body).toMatchObject({ code: 'email.unverified' });
        });

        it('#93: a link minted for B does not verify A, and a tampered link is refused like an unknown one', async () => {
            const tokenB = tokenIn(lastMailTo(emailB, 'email_verification'));
            const tampered = `${tokenB.slice(0, -2)}${tokenB.endsWith('AA') ? 'BB' : 'AA'}`;
            const bad = await http().post('/api/auth/email/verify').send({ token: tampered }).expect(400);
            expect(bad.body).toMatchObject({ code: 'token.invalid' });
            await http().post('/api/auth/email/verify').send({ token: tokenB }).expect(204);
            const meA = await http().get('/api/me').set('Cookie', a.cookie).expect(200);
            expect(meA.body).toMatchObject({ emailVerified: false });
        });

        it('#93: asking again mails a new link and the older one stops working', async () => {
            const first = tokenIn(lastMailTo(emailA, 'email_verification'));
            await http()
                .post('/api/auth/email/verification')
                .set('Cookie', a.cookie)
                .set(CSRF_HEADER, a.csrf)
                .expect(204);
            await deliverMail(app);
            const second = tokenIn(lastMailTo(emailA, 'email_verification'));
            expect(second).not.toBe(first);
            const stale = await http().post('/api/auth/email/verify').send({ token: first }).expect(400);
            expect(stale.body).toMatchObject({ code: 'token.invalid' });
        });

        it('#93: the link verifies once; the tenant routes then answer; a second use is refused', async () => {
            const token = tokenIn(lastMailTo(emailA, 'email_verification'));
            await http().post('/api/auth/email/verify').send({ token }).expect(204);
            const again = await http().post('/api/auth/email/verify').send({ token }).expect(400);
            expect(again.body).toMatchObject({ code: 'token.invalid' });
            const me = await http().get('/api/me').set('Cookie', a.cookie).expect(200);
            expect(me.body).toMatchObject({ emailVerified: true });
            await http().get(`/api/w/${workspaceA}/roles`).set('Cookie', a.cookie).expect(200);
        });

        it('#93: an expired link is refused like an unknown one', async () => {
            const email = `mail-exp-${stamp}@example.test`;
            await http().post('/api/auth/signup').send({ email, password, workspaceName: 'Expiry' }).expect(201);
            await deliverMail(app);
            const token = tokenIn(lastMailTo(email, 'email_verification'));
            await owner.oneTimeToken.update({
                where: { tokenHash: hashToken(token) },
                data: { expiresAt: new Date(Date.now() - 1000) },
            });
            const res = await http().post('/api/auth/email/verify').send({ token }).expect(400);
            expect(res.body).toMatchObject({ code: 'token.invalid' });
        });

        it('#93: the tokens are stored as hashes only', async () => {
            const token = tokenIn(lastMailTo(emailB, 'email_verification'));
            const rows = await owner.oneTimeToken.findMany({ where: { email: emailB } });
            expect(rows.length).toBeGreaterThan(0);
            expect(JSON.stringify(rows)).not.toContain(token);
        });
    });

    describe('password reset', () => {
        it('#93: answers the same for an unknown address, a provider-only account and a real one; mails only the real one', async () => {
            const providerOnly = `mail-oidc-${stamp}@example.test`;
            await owner.user.create({ data: { email: providerOnly, emailVerifiedAt: new Date() } });
            const answers: unknown[] = [];
            for (const email of [`nobody-${stamp}@example.test`, providerOnly, emailA]) {
                const res = await http().post('/api/auth/password/forgot').send({ email }).expect(204);
                const { requestId: _ignored, ...body } = (res.body ?? {}) as Record<string, unknown>;
                answers.push(body);
            }
            expect(answers[1]).toEqual(answers[0]);
            expect(answers[2]).toEqual(answers[0]);
            await deliverMail(app);
            expect(mailTo(`nobody-${stamp}@example.test`)).toHaveLength(0);
            expect(mailTo(emailA, 'password_reset')).toHaveLength(1);
            // A provider-only account may set a password by proving the mailbox: it gets the link too.
            expect(mailTo(providerOnly, 'password_reset')).toHaveLength(1);
        });

        it('#93: the reset link sets the password, signs this browser in and revokes every other session', async () => {
            const other = browserFrom(
                await http().post('/api/auth/login').send({ email: emailA, password }).expect(200),
            );
            const token = tokenIn(lastMailTo(emailA, 'password_reset'));
            const newPassword = 'a different long passphrase';
            const res = await http()
                .post('/api/auth/password/reset')
                .send({ token, password: newPassword })
                .expect(200);
            expect(res.body).toMatchObject({ user: { email: emailA } });
            const fresh = browserFrom(res);
            await http().get('/api/me').set('Cookie', fresh.cookie).expect(200);
            await http().get('/api/me').set('Cookie', other.cookie).expect(401);
            await http().get('/api/me').set('Cookie', a.cookie).expect(401);
            await http().post('/api/auth/login').send({ email: emailA, password }).expect(401);
            await http().post('/api/auth/login').send({ email: emailA, password: newPassword }).expect(200);
            const reused = await http()
                .post('/api/auth/password/reset')
                .send({ token, password: 'yet another long passphrase' })
                .expect(400);
            expect(reused.body).toMatchObject({ code: 'token.invalid' });
            a = fresh;
        });

        it('#93: a verification link cannot be used as a reset link', async () => {
            const email = `mail-cross-${stamp}@example.test`;
            await http().post('/api/auth/signup').send({ email, password, workspaceName: 'Cross' }).expect(201);
            await deliverMail(app);
            const verifyToken = tokenIn(lastMailTo(email, 'email_verification'));
            const res = await http()
                .post('/api/auth/password/reset')
                .send({ token: verifyToken, password: 'a different long passphrase' })
                .expect(400);
            expect(res.body).toMatchObject({ code: 'token.invalid' });
        });

        it('one address takes at most RESET_REQUEST_ADDRESS_MAX requests per window, however many IPs ask', async () => {
            const email = `nobody-flood-${stamp}@example.test`;
            const from = (n: number) =>
                http().post('/api/auth/password/forgot').set('X-Forwarded-For', `198.51.100.${n}`);
            for (let n = 1; n <= RESET_REQUEST_ADDRESS_MAX; n++) await from(n).send({ email }).expect(204);
            await from(RESET_REQUEST_ADDRESS_MAX + 1)
                .send({ email })
                .expect(429);
        });

        it('one IP takes at most RESET_REQUEST_IP_MAX requests per window, across addresses', async () => {
            const from = () => http().post('/api/auth/password/forgot').set('X-Forwarded-For', '203.0.113.7');
            for (let n = 1; n <= RESET_REQUEST_IP_MAX; n++) {
                await from()
                    .send({ email: `nobody-probe-${n}-${stamp}@example.test` })
                    .expect(204);
            }
            await from()
                .send({ email: `nobody-probe-last-${stamp}@example.test` })
                .expect(429);
        });
    });

    describe('invitations by mail', () => {
        let memberRoleId: string;

        it('#93: a workspace invitation is mailed to the invitee and still returned once to the inviter', async () => {
            const roles = await http().get(`/api/w/${workspaceA}/roles`).set('Cookie', a.cookie).expect(200);
            memberRoleId = (roles.body as { id: string; name: string }[]).find(
                (r) => r.name === SYSTEM_ROLES.member,
            )!.id;
            const invitee = `mail-inv-${stamp}@example.test`;
            const res = await http()
                .post(`/api/w/${workspaceA}/invites`)
                .set('Cookie', a.cookie)
                .set(CSRF_HEADER, a.csrf)
                .send({ email: invitee, roleId: memberRoleId })
                .expect(201);
            const { token } = res.body as { token: string };
            await deliverMail(app);
            const mail = lastMailTo(invitee, 'workspace_invitation');
            expect(mail.subject).toContain('Mail Alpha');
            expect(mail.text).toContain(encodeURIComponent(token));
        });

        it('#93: an invitation is mailed once even when the answer is lost and the send is retried', async () => {
            const invitee = `mail-retry-${stamp}@example.test`;
            const res = await http()
                .post(`/api/w/${workspaceA}/invites`)
                .set('Cookie', a.cookie)
                .set(CSRF_HEADER, a.csrf)
                .send({ email: invitee, roleId: memberRoleId })
                .expect(201);
            const key = `invite-${(res.body as { invite: { id: string } }).invite.id}`;
            transport.loseNextAnswer();
            await deliverMail(app);
            const row = await owner.mailOutbox.findUniqueOrThrow({ where: { idempotencyKey: key } });
            expect(row).toMatchObject({ sentAt: null, failedAt: null, attempts: 1 });
            expect(row.nextAttemptAt).not.toBeNull();
            // The retry comes due; the same idempotency key reaches the transport again.
            await deliverMail(app, () => new Date(Date.now() + 60 * 60_000));
            expect(mailTo(invitee, 'workspace_invitation')).toHaveLength(1);
            expect(transport.calls.filter((c) => c.key === key)).toHaveLength(2);
            const sent = await owner.mailOutbox.findUniqueOrThrow({ where: { idempotencyKey: key } });
            expect(sent.sentAt).not.toBeNull();
        });

        it('#93: a mail recorded twice is one row, and its sealed payload is wiped once sent', async () => {
            const mail = {
                kind: 'workspace_invitation' as const,
                to: `mail-dup-${stamp}@example.test`,
                subject: 'dup',
                html: '<p>dup</p>',
                text: 'dup',
                idempotencyKey: `test-dup-${stamp}`,
            };
            const outbox = app.get(MailOutbox);
            await outbox.record(owner, mail);
            await outbox.record(owner, mail);
            const rows = await owner.mailOutbox.findMany({ where: { idempotencyKey: mail.idempotencyKey } });
            expect(rows).toHaveLength(1);
            expect(rows[0]!.sealed).not.toContain(mail.to);
            await deliverMail(app);
            expect(mailTo(mail.to)).toHaveLength(1);
            const sent = await owner.mailOutbox.findUniqueOrThrow({ where: { idempotencyKey: mail.idempotencyKey } });
            expect(sent).toMatchObject({ sealed: '', failedAt: null });
            expect(sent.sentAt).not.toBeNull();
        });

        it('#93: an account created from an invitation starts unverified and is mailed a verification link', async () => {
            const invitee = `mail-join-${stamp}@example.test`;
            const res = await http()
                .post(`/api/w/${workspaceA}/invites`)
                .set('Cookie', a.cookie)
                .set(CSRF_HEADER, a.csrf)
                .send({ email: invitee, roleId: memberRoleId })
                .expect(201);
            const { token } = res.body as { token: string };
            const joined = browserFrom(
                await http().post(`/api/auth/invites/${token}/signup`).send({ password }).expect(201),
            );
            const me = await http().get('/api/me').set('Cookie', joined.cookie).expect(200);
            expect(me.body).toMatchObject({ email: invitee, emailVerified: false });
            const refused = await http().get(`/api/w/${workspaceA}/roles`).set('Cookie', joined.cookie).expect(403);
            expect(refused.body).toMatchObject({ code: 'email.unverified' });
            await deliverMail(app);
            const verify = tokenIn(lastMailTo(invitee, 'email_verification'));
            await http().post('/api/auth/email/verify').send({ token: verify }).expect(204);
            await http().get(`/api/w/${workspaceA}/roles`).set('Cookie', joined.cookie).expect(200);
        });
    });

    describe('after commit, never inside a transaction', () => {
        it('#93: a rolled-back invitation records no mail', async () => {
            await deliverMail(app);
            const before = new Date();
            const invitee = `mail-rollback-${stamp}@example.test`;
            // An unknown role id fails the insert inside the transaction.
            await http()
                .post(`/api/w/${workspaceA}/invites`)
                .set('Cookie', a.cookie)
                .set(CSRF_HEADER, a.csrf)
                .send({ email: invitee, roleId: '00000000-0000-4000-8000-000000000000' })
                .expect((r) => expect(r.status).toBeGreaterThanOrEqual(400));
            expect(
                await owner.mailOutbox.count({ where: { workspaceId: workspaceA, createdAt: { gte: before } } }),
            ).toBe(0);
            await deliverMail(app);
            expect(mailTo(invitee)).toHaveLength(0);
        });

        it('#93: the transport is never called inside a tenant transaction', () => {
            expect(transport.calls.length).toBeGreaterThan(0);
            expect(transport.calls.filter((c) => c.insideTransaction)).toEqual([]);
        });
    });

    describe('two mail relays on one database (shared relay engine)', () => {
        let second: INestApplication;
        let relayA: MailOutboxRelay;
        let relayB: MailOutboxRelay;
        /** Which relay's transport was asked to send which mail. */
        let sends: { relay: 'A' | 'B'; key: string }[];

        const recordMany = async (count: number, tag: string): Promise<string[]> => {
            await deliverMail(app);
            const outbox = app.get(MailOutbox);
            const keys = Array.from({ length: count }, (_, i) => `test-${tag}-${stamp}-${i}`);
            for (const key of keys) {
                await outbox.record(owner, {
                    kind: 'email_verification',
                    to: `${key}@example.test`,
                    subject: 'concurrent',
                    html: '<p>c</p>',
                    text: 'c',
                    idempotencyKey: key,
                });
            }
            return keys;
        };

        beforeAll(async () => {
            // A second process: its own application, pools and (memory) transport, the same database.
            second = await createApp();
            await second.init();
            relayA = app.get(MailOutboxRelay);
            relayB = second.get(MailOutboxRelay);
            const transportB = second.get<TransactionalMailTransport>(TRANSACTIONAL_MAIL_TRANSPORT);
            const sendB = transportB.send.bind(transportB);
            vi.spyOn(transportB, 'send').mockImplementation((mail) => {
                sends.push({ relay: 'B', key: mail.idempotencyKey });
                return sendB(mail);
            });
            const sendA = transport.send.bind(transport);
            vi.spyOn(transport, 'send').mockImplementation((mail) => {
                sends.push({ relay: 'A', key: mail.idempotencyKey });
                return sendA(mail);
            });
        });

        afterAll(async () => {
            vi.restoreAllMocks();
            await second?.close();
        });

        it('#93: scanning at the same moment, they send every mail exactly once — no claim is shared', async () => {
            const keys = await recordMany(60, 'concurrent');
            sends = [];
            const now = new Date();
            for (;;) {
                const claimed = await Promise.all([
                    relayA.runOnce(now),
                    relayB.runOnce(now),
                    relayA.runOnce(now),
                    relayB.runOnce(now),
                ]);
                if (claimed.every((n) => n === 0)) break;
            }
            const mine = sends.filter((s) => keys.includes(s.key));
            expect(mine).toHaveLength(keys.length);
            expect(new Set(mine.map((s) => s.key)).size).toBe(keys.length);
            expect(new Set(mine.map((s) => s.relay))).toEqual(new Set(['A', 'B']));
            const rows = await owner.mailOutbox.findMany({ where: { idempotencyKey: { in: keys } } });
            expect(rows.every((r) => r.sentAt !== null && r.attempts === 1 && r.sealed === '')).toBe(true);
        });

        it('#93: a mail one relay holds is not taken by the other until the lease expires, then the other sends it', async () => {
            const [key] = await recordMany(1, 'lease');
            sends = [];
            let release!: () => void;
            const stalled = new Promise<void>((resolve) => (release = resolve));
            let entered!: () => void;
            const inside = new Promise<void>((resolve) => (entered = resolve));
            const sendA = vi.mocked(transport.send).getMockImplementation()!;
            vi.mocked(transport.send).mockImplementationOnce(async (mail) => {
                entered();
                await stalled;
                return sendA(mail);
            });

            const claimedAt = Date.now();
            const held = relayA.runOnce(new Date(claimedAt));
            await inside;

            await relayB.runOnce(new Date(claimedAt + MAIL_OUTBOX_LEASE_MS - 1));
            expect(sends.filter((s) => s.key === key && s.relay === 'B')).toHaveLength(0);

            await relayB.runOnce(new Date(claimedAt + MAIL_OUTBOX_LEASE_MS));
            expect(sends.filter((s) => s.key === key && s.relay === 'B')).toHaveLength(1);
            const handedOver = await owner.mailOutbox.findUniqueOrThrow({ where: { idempotencyKey: key! } });
            expect(handedOver.sentAt).not.toBeNull();
            expect(handedOver.attempts).toBe(2);

            // A wakes and sends too, with the same idempotency key: the provider keeps one message.
            release();
            await held;
            expect(mailTo(`${key}@example.test`)).toHaveLength(1);
        });
    });
});

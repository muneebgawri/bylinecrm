import 'reflect-metadata';
import { Logger, type INestApplication } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import {
    CSRF_COOKIE,
    CSRF_HEADER,
    GMAIL_BROAD_SCOPE,
    GMAIL_READONLY_SCOPE,
    GMAIL_SCOPES,
    GMAIL_SEND_SCOPE,
    MEMBER_DEFAULT_CAPABILITIES,
    SESSION_COOKIE,
    SYSTEM_ROLES,
} from '@bylinecrm/shared';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_OPTIONS, configureApp } from '../../src/app';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/infra/prisma.service';
import { RedisService } from '../../src/infra/redis.service';
import { GOOGLE_OAUTH_PORT } from '../../src/mail-accounts/google-oauth.port';
import { CONNECT_STATE_KEY_PREFIX, MAIL_OAUTH_CALLBACK_PATH } from '../../src/mail-accounts/mail-accounts.constants';
import { MailboxTokens, MailboxUnavailable } from '../../src/mail-accounts/mailbox-tokens.service';
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

interface Mailbox {
    id: string;
    ownerMemberId: string;
    email: string;
    label: string | null;
    purpose: 'personal' | 'pool';
    status: 'connected' | 'reconnect_needed' | 'disconnected';
    grantedScopes: string[];
    lastError: { code: string; message: string; at: string } | null;
}
interface ClientView {
    configured: boolean;
    clientId: string | null;
    clientSecretLast4: string | null;
    redirectUri: string;
    scopes: string[];
    verifiedAt: string | null;
    liveMailboxes: number;
    lastCheck: {
        format: { outcome: string };
        credentials: { outcome: string };
        redirectUri: { outcome: string };
    } | null;
}

/**
 * Mail accounts end to end (P2-1) against an in-memory Google: an admin configures the
 * workspace's own OAuth client; a member connects a mailbox with exactly the two narrow scopes,
 * through a server-side state used once and a PKCE verifier Google checks; the connect is finished
 * only by the person who started it; a broader or narrower grant is refused; tokens are refreshed
 * when due by one process at a time, and a grant Google refuses moves the mailbox to
 * `reconnect_needed`, announced once; disconnecting revokes and wipes. One workspace never sees
 * another's client or mailboxes, and no token or secret appears in any response or log line.
 */
describe('mail accounts', () => {
    let app: INestApplication;
    let http: () => request.Agent;
    let owner: PrismaService;
    let tokens: MailboxTokens;
    const google = new FakeGoogleOAuth();

    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const password = 'correct horse battery staple';
    let admin: Browser;
    let member: Browser;
    let otherAdmin: Browser;
    let workspace: string;
    let otherWorkspace: string;
    let memberRoleId: string;
    let redirectUri: string;

    const clientId = `111-${stamp.replace(/[^a-z0-9]/g, '')}.apps.googleusercontent.com`;
    const clientSecret = `GOCSPX-${stamp}-secret-tail-WXYZ`;

    /** Every response body, every log line and every event, for the leak checks at the end. */
    const bodies: string[] = [];
    const logs: string[] = [];
    const events: { type: string; workspaceId: string; recordId: string; actor: { kind: string } }[] = [];
    const track = (res: Response): Response => {
        bodies.push(res.text ?? '');
        return res;
    };

    const as = (who: Browser | null) => ({
        get: (path: string) => (who ? http().get(path).set('Cookie', who.cookie) : http().get(path)),
        post: (path: string) => http().post(path).set('Cookie', who!.cookie).set(CSRF_HEADER, who!.csrf),
        put: (path: string) => http().put(path).set('Cookie', who!.cookie).set(CSRF_HEADER, who!.csrf),
        patch: (path: string) => http().patch(path).set('Cookie', who!.cookie).set(CSRF_HEADER, who!.csrf),
        delete: (path: string) => http().delete(path).set('Cookie', who!.cookie).set(CSRF_HEADER, who!.csrf),
    });
    const w = (path: string, id = workspace) => `/api/w/${id}${path}`;

    /** Follows the API's authorization URL through the fake consent screen and back to the callback. */
    async function connect(
        who: Browser,
        purpose: 'personal' | 'pool',
        consent: { email: string; scopes: string[]; withRefreshToken?: boolean },
        finishAs: Browser | null = who,
        ws = workspace,
    ): Promise<{ result: string | null; location: URL; authorizeUrl: URL; state: string }> {
        const start = track(await as(who).post(w('/mailboxes/connect', ws)).send({ purpose }));
        expect(start.status).toBe(201);
        const authorizeUrl = new URL((start.body as { authorizeUrl: string }).authorizeUrl);
        const { code, state } = google.consent(authorizeUrl.toString(), consent);
        const callback = track(
            await as(finishAs).get(
                `${MAIL_OAUTH_CALLBACK_PATH}?state=${encodeURIComponent(state)}&code=${encodeURIComponent(code)}`,
            ),
        );
        expect(callback.status).toBe(302);
        const location = new URL(String(callback.headers['location']));
        return { result: location.searchParams.get('connect'), location, authorizeUrl, state };
    }

    async function list(who: Browser, ws = workspace): Promise<Mailbox[]> {
        const res = track(await as(who).get(w('/mailboxes', ws)));
        expect(res.status).toBe(200);
        return res.body as Mailbox[];
    }

    beforeAll(async () => {
        for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
            const original = Logger.prototype[level];
            Logger.prototype[level] = function (this: Logger, ...args: unknown[]) {
                logs.push(
                    args.map((a) => (a instanceof Error ? `${a.message} ${a.stack ?? ''}` : String(a))).join(' '),
                );
                return (original as (...a: unknown[]) => void).apply(this, args);
            };
        }

        const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
            .overrideProvider(GOOGLE_OAUTH_PORT)
            .useValue(google)
            .compile();
        app = configureApp(moduleRef.createNestApplication<NestExpressApplication>(APP_OPTIONS));
        await app.init();
        http = () => request(app.getHttpServer() as Parameters<typeof request>[0]);
        owner = app.get(PrismaService);
        tokens = app.get(MailboxTokens);
        app.get(EventEmitter2).onAny((type: string | string[], payload: unknown) => {
            if (typeof type === 'string' && type.startsWith('mailbox.')) {
                events.push(payload as (typeof events)[number]);
            }
        });

        const signUp = async (email: string, name: string) => {
            const res = await http().post('/api/auth/signup').send({ email, password, workspaceName: name });
            expect(res.status).toBe(201);
            return { browser: browserFrom(res), workspace: (res.body as { workspace: { id: string } }).workspace.id };
        };
        ({ browser: admin, workspace } = await signUp(`mail-admin-${stamp}@example.com`, `Mail ${stamp}`));
        ({ browser: otherAdmin, workspace: otherWorkspace } = await signUp(
            `mail-other-${stamp}@example.com`,
            `Other ${stamp}`,
        ));

        const roles = await as(admin).get(w('/roles'));
        memberRoleId = (roles.body as { id: string; name: string }[]).find((r) => r.name === SYSTEM_ROLES.member)!.id;
        const invite = await as(admin)
            .post(w('/invites'))
            .send({ email: `mail-member-${stamp}@example.com`, roleId: memberRoleId });
        expect(invite.status).toBe(201);
        const joined = await http()
            .post(`/api/auth/invites/${(invite.body as { token: string }).token}/signup`)
            .send({ password });
        expect(joined.status).toBe(201);
        member = browserFrom(joined);
    });

    afterAll(async () => {
        await app?.close();
    });

    describe('the OAuth client', () => {
        it('shows an admin the redirect URI and the two scopes before anything is configured; members get 403', async () => {
            const res = track(await as(admin).get(w('/mail/oauth-client')));
            expect(res.status).toBe(200);
            const view = res.body as ClientView;
            expect(view).toMatchObject({
                configured: false,
                clientId: null,
                clientSecretLast4: null,
                liveMailboxes: 0,
            });
            expect(view.scopes).toEqual([...GMAIL_SCOPES]);
            expect(view.scopes).not.toContain(GMAIL_BROAD_SCOPE);
            expect(new URL(view.redirectUri).pathname).toBe(MAIL_OAUTH_CALLBACK_PATH);
            redirectUri = view.redirectUri;

            const asMember = track(await as(member).get(w('/mail/oauth-client')));
            expect(asMember.status).toBe(403);
        });

        it('refuses a client ID that is not a Google web client ID', async () => {
            const res = track(
                await as(admin).put(w('/mail/oauth-client')).send({ clientId: 'not-a-client', clientSecret: 'x' }),
            );
            expect(res.status).toBe(400);
            expect(res.body).toMatchObject({ code: 'validation.failed' });
        });

        it('stores the secret sealed: only its last four characters ever come back', async () => {
            const res = track(await as(admin).put(w('/mail/oauth-client')).send({ clientId, clientSecret }));
            expect(res.status).toBe(200);
            expect(res.body).toMatchObject({ configured: true, clientId, clientSecretLast4: 'WXYZ', verifiedAt: null });
            expect(res.text).not.toContain(clientSecret);
            const [row] = await owner.$queryRaw<{ client_secret_ciphertext: string }[]>`
                SELECT client_secret_ciphertext FROM google_oauth_clients WHERE workspace_id = ${workspace}::uuid`;
            expect(row!.client_secret_ciphertext).not.toContain(clientSecret);
            expect(row!.client_secret_ciphertext.startsWith('v1.')).toBe(true);
        });

        it('verify reports what Google says without a sign-in: credentials, and the redirect URI only if wrong', async () => {
            // Unknown to "Google" yet: the credentials are refused.
            let res = track(await as(admin).post(w('/mail/oauth-client/verify')));
            expect(res.status).toBe(200);
            expect((res.body as ClientView).lastCheck).toMatchObject({
                format: { outcome: 'pass' },
                credentials: { outcome: 'fail' },
            });

            // Registered, but without our redirect URI: Google names the redirect URI.
            google.registerClient(clientId, clientSecret, ['https://elsewhere.example/cb']);
            res = track(await as(admin).post(w('/mail/oauth-client/verify')));
            expect((res.body as ClientView).lastCheck).toMatchObject({
                credentials: { outcome: 'pass' },
                redirectUri: { outcome: 'fail' },
            });

            // Registered properly: the credentials pass; the redirect URI waits for the first connect.
            google.registerClient(clientId, clientSecret, [redirectUri]);
            res = track(await as(admin).post(w('/mail/oauth-client/verify')));
            expect((res.body as ClientView).lastCheck).toMatchObject({
                format: { outcome: 'pass' },
                credentials: { outcome: 'pass' },
                redirectUri: { outcome: 'unverified' },
            });
        });
    });

    describe('connecting', () => {
        it('an admin connects a personal mailbox with exactly the narrow scopes, and the client is proven', async () => {
            const before = events.length;
            const { result, location, authorizeUrl } = await connect(admin, 'personal', {
                email: `Admin.${stamp}@Example.com`,
                scopes: [...GMAIL_SCOPES],
            });
            expect(result).toBe('connected');
            expect(location.pathname).toBe(`/w/${workspace}/mailboxes`);
            expect(authorizeUrl.searchParams.get('scope')?.split(' ')).toEqual([...GMAIL_SCOPES]);
            expect(authorizeUrl.searchParams.get('access_type')).toBe('offline');
            expect(authorizeUrl.searchParams.get('code_challenge_method')).toBe('S256');
            expect(authorizeUrl.searchParams.get('redirect_uri')).toBe(redirectUri);

            const mailboxes = await list(admin);
            expect(mailboxes).toHaveLength(1);
            expect(mailboxes[0]).toMatchObject({
                email: `admin.${stamp}@example.com`,
                purpose: 'personal',
                status: 'connected',
                lastError: null,
            });
            expect(mailboxes[0]!.grantedScopes).toEqual([...GMAIL_SCOPES]);

            const client = track(await as(admin).get(w('/mail/oauth-client'))).body as ClientView;
            expect(client.verifiedAt).not.toBeNull();
            expect(client.liveMailboxes).toBe(1);

            const announced = events.slice(before);
            expect(announced).toHaveLength(1);
            expect(announced[0]).toMatchObject({
                type: 'mailbox.connected',
                workspaceId: workspace,
                recordId: mailboxes[0]!.id,
            });
        });

        it('a state is accepted once, expires, and an unknown one is refused', async () => {
            const start = track(await as(admin).post(w('/mailboxes/connect')).send({ purpose: 'personal' }));
            const { code, state } = google.consent((start.body as { authorizeUrl: string }).authorizeUrl, {
                email: `once-${stamp}@example.com`,
                scopes: [...GMAIL_SCOPES],
            });
            const first = track(await as(admin).get(`${MAIL_OAUTH_CALLBACK_PATH}?state=${state}&code=${code}`));
            expect(new URL(String(first.headers['location'])).searchParams.get('connect')).toBe('connected');
            const again = track(await as(admin).get(`${MAIL_OAUTH_CALLBACK_PATH}?state=${state}&code=${code}`));
            const againUrl = new URL(String(again.headers['location']));
            expect(againUrl.searchParams.get('connect')).toBe('invalid_state');
            expect(againUrl.pathname).toBe('/workspaces');

            const expiring = track(await as(admin).post(w('/mailboxes/connect')).send({ purpose: 'personal' }));
            const pending = google.consent((expiring.body as { authorizeUrl: string }).authorizeUrl, {
                email: `late-${stamp}@example.com`,
                scopes: [...GMAIL_SCOPES],
            });
            await app.get(RedisService).pexpire(`${CONNECT_STATE_KEY_PREFIX}${pending.state}`, 1);
            await new Promise((r) => setTimeout(r, 20));
            const late = track(
                await as(admin).get(`${MAIL_OAUTH_CALLBACK_PATH}?state=${pending.state}&code=${pending.code}`),
            );
            expect(new URL(String(late.headers['location'])).searchParams.get('connect')).toBe('invalid_state');

            const guessed = track(await as(admin).get(`${MAIL_OAUTH_CALLBACK_PATH}?state=guessed&code=whatever`));
            expect(new URL(String(guessed.headers['location'])).searchParams.get('connect')).toBe('invalid_state');

            const addresses = (await list(admin)).map((m) => m.email);
            expect(addresses).toContain(`once-${stamp}@example.com`);
            expect(addresses).not.toContain(`late-${stamp}@example.com`);
        });

        it('is finished only by the signed-in person who started it', async () => {
            const byOther = await connect(
                member,
                'personal',
                { email: `hijack-${stamp}@example.com`, scopes: [...GMAIL_SCOPES] },
                admin,
            );
            expect(byOther.result).toBe('wrong_user');
            const anonymous = await connect(
                member,
                'personal',
                { email: `hijack-${stamp}@example.com`, scopes: [...GMAIL_SCOPES] },
                null,
            );
            expect(anonymous.result).toBe('wrong_user');
            expect((await list(admin)).map((m) => m.email)).not.toContain(`hijack-${stamp}@example.com`);
        });

        it('refuses full mailbox access and a missing narrow scope, storing nothing', async () => {
            const broad = await connect(admin, 'personal', {
                email: `broad-${stamp}@example.com`,
                scopes: [GMAIL_SEND_SCOPE, GMAIL_READONLY_SCOPE, GMAIL_BROAD_SCOPE],
            });
            expect(broad.result).toBe('scope_too_broad');
            const narrow = await connect(admin, 'personal', {
                email: `narrow-${stamp}@example.com`,
                scopes: [GMAIL_SEND_SCOPE],
            });
            expect(narrow.result).toBe('scope_missing');
            const addresses = (await list(admin)).map((m) => m.email);
            expect(addresses).not.toContain(`broad-${stamp}@example.com`);
            expect(addresses).not.toContain(`narrow-${stamp}@example.com`);
        });

        it('reports a declined consent, a grant without a refresh token, and a refused exchange', async () => {
            const start = track(await as(admin).post(w('/mailboxes/connect')).send({ purpose: 'personal' }));
            const state = new URL((start.body as { authorizeUrl: string }).authorizeUrl).searchParams.get('state')!;
            const declined = track(
                await as(admin).get(`${MAIL_OAUTH_CALLBACK_PATH}?state=${state}&error=access_denied`),
            );
            expect(new URL(String(declined.headers['location'])).searchParams.get('connect')).toBe('denied');

            const noRefresh = await connect(admin, 'personal', {
                email: `norefresh-${stamp}@example.com`,
                scopes: [...GMAIL_SCOPES],
                withRefreshToken: false,
            });
            expect(noRefresh.result).toBe('no_refresh_token');

            google.failExchangeWith = 'invalid_grant';
            const refused = await connect(admin, 'personal', {
                email: `refused-${stamp}@example.com`,
                scopes: [...GMAIL_SCOPES],
            });
            expect(refused.result).toBe('exchange_failed');
        });

        it('cannot be finished by a member who lost mailbox:manage after starting', async () => {
            const start = track(await as(member).post(w('/mailboxes/connect')).send({ purpose: 'personal' }));
            expect(start.status).toBe(201);
            const pending = google.consent((start.body as { authorizeUrl: string }).authorizeUrl, {
                email: `revoked-${stamp}@example.com`,
                scopes: [...GMAIL_SCOPES],
            });
            const withoutManage = MEMBER_DEFAULT_CAPABILITIES.filter((c) => c !== 'mailbox:manage');
            expect(
                track(
                    await as(admin)
                        .patch(w(`/roles/${memberRoleId}`))
                        .send({ capabilities: withoutManage }),
                ).status,
            ).toBe(200);
            const res = track(
                await as(member).get(`${MAIL_OAUTH_CALLBACK_PATH}?state=${pending.state}&code=${pending.code}`),
            );
            expect(new URL(String(res.headers['location'])).searchParams.get('connect')).toBe('not_permitted');
            expect(
                track(
                    await as(admin)
                        .patch(w(`/roles/${memberRoleId}`))
                        .send({ capabilities: [...MEMBER_DEFAULT_CAPABILITIES] }),
                ).status,
            ).toBe(200);
        });

        it('an API key cannot start a connect: a mailbox is connected by a person', async () => {
            const roles = track(await as(admin).get(w('/roles'))).body as { id: string; name: string }[];
            const adminRole = roles.find((r) => r.name === SYSTEM_ROLES.admin)!;
            const key = track(
                await as(admin)
                    .post(w('/api-keys'))
                    .send({ name: `mail-${stamp}`, roleId: adminRole.id }),
            );
            const secret = (key.body as { secret: string }).secret;
            const res = track(
                await http()
                    .post(w('/mailboxes/connect'))
                    .set('Authorization', `Bearer ${secret}`)
                    .send({ purpose: 'pool' }),
            );
            expect(res.status).toBe(403);
        });
    });

    describe('who sees and changes what', () => {
        let adminPersonal: Mailbox;
        let adminPool: Mailbox;
        let memberPersonal: Mailbox;

        it('a member sees their own mailboxes and the pool; an admin sees every mailbox', async () => {
            expect(
                (await connect(admin, 'pool', { email: `pool-${stamp}@example.com`, scopes: [...GMAIL_SCOPES] }))
                    .result,
            ).toBe('connected');
            expect(
                (await connect(member, 'personal', { email: `member-${stamp}@example.com`, scopes: [...GMAIL_SCOPES] }))
                    .result,
            ).toBe('connected');
            const all = await list(admin);
            adminPersonal = all.find((m) => m.email === `admin.${stamp}@example.com`)!;
            adminPool = all.find((m) => m.email === `pool-${stamp}@example.com`)!;
            memberPersonal = all.find((m) => m.email === `member-${stamp}@example.com`)!;
            expect(adminPool.purpose).toBe('pool');

            const seen = (await list(member)).map((m) => m.email).sort();
            expect(seen).toEqual([`member-${stamp}@example.com`, `pool-${stamp}@example.com`].sort());
            const hidden = track(await as(member).get(w(`/mailboxes/${adminPersonal.id}`)));
            expect(hidden.status).toBe(404);
        });

        it('a member cannot change a pool mailbox they do not own; an admin can change any', async () => {
            const res = track(
                await as(member)
                    .patch(w(`/mailboxes/${adminPool.id}`))
                    .send({ label: 'mine now' }),
            );
            expect(res.status).toBe(403);
            const byAdmin = track(
                await as(admin)
                    .patch(w(`/mailboxes/${memberPersonal.id}`))
                    .send({ label: 'Member inbox' }),
            );
            expect(byAdmin.status).toBe(200);
            expect(byAdmin.body).toMatchObject({ label: 'Member inbox' });
        });

        it("a mailbox's purpose is fixed: a different one is refused, the same one is accepted", async () => {
            const changed = track(
                await as(admin)
                    .patch(w(`/mailboxes/${adminPersonal.id}`))
                    .send({ purpose: 'pool' }),
            );
            expect(changed.status).toBe(409);
            expect(changed.body).toMatchObject({ code: 'conflict' });
            const same = track(
                await as(admin)
                    .patch(w(`/mailboxes/${adminPersonal.id}`))
                    .send({ purpose: 'personal', label: 'Admin inbox' }),
            );
            expect(same.status).toBe(200);
            expect(same.body).toMatchObject({ purpose: 'personal', label: 'Admin inbox' });
        });

        it('an address connected by one member cannot be taken by another, or reconnected with the other purpose', async () => {
            const taken = await connect(member, 'personal', {
                email: `pool-${stamp}@example.com`,
                scopes: [...GMAIL_SCOPES],
            });
            expect(taken.result).toBe('owned_by_another');
            const otherPurpose = await connect(admin, 'personal', {
                email: `pool-${stamp}@example.com`,
                scopes: [...GMAIL_SCOPES],
            });
            expect(otherPurpose.result).toBe('purpose_mismatch');
            const again = await connect(admin, 'pool', {
                email: `pool-${stamp}@example.com`,
                scopes: [...GMAIL_SCOPES],
            });
            expect(again.result).toBe('connected');
            expect((await list(admin)).filter((m) => m.email === `pool-${stamp}@example.com`)).toHaveLength(1);
        });

        it("one workspace never sees another's client or mailboxes, nor finishes another's connect", async () => {
            expect(await list(otherAdmin, otherWorkspace)).toEqual([]);
            const peek = track(await as(otherAdmin).get(w(`/mailboxes/${adminPersonal.id}`, otherWorkspace)));
            expect(peek.status).toBe(404);
            const client = track(await as(otherAdmin).get(w('/mail/oauth-client', otherWorkspace))).body as ClientView;
            expect(client).toMatchObject({ configured: false, clientId: null });
            const crossed = await connect(
                admin,
                'personal',
                { email: `crossed-${stamp}@example.com`, scopes: [...GMAIL_SCOPES] },
                otherAdmin,
            );
            expect(crossed.result).toBe('wrong_user');
            expect(crossed.location.pathname).toBe(`/w/${workspace}/mailboxes`);
            const rows = await owner.$queryRaw<{ n: number }[]>`
                SELECT count(*)::int AS n FROM mailboxes WHERE workspace_id = ${otherWorkspace}::uuid`;
            expect(rows[0]!.n).toBe(0);
        });
    });

    describe('tokens', () => {
        const mailboxIdOf = async (email: string): Promise<string> =>
            (await list(admin)).find((m) => m.email === email)!.id;
        const expire = (id: string) =>
            owner.$executeRaw`UPDATE mailboxes SET access_expires_at = now() - interval '1 minute' WHERE id = ${id}::uuid`;

        it('a token due to expire is refreshed by one process at a time; the others read its result', async () => {
            const id = await mailboxIdOf(`member-${stamp}@example.com`);
            await expire(id);
            google.refreshDelayMs = 300;
            const before = google.refreshCalls;
            const results = await Promise.all(Array.from({ length: 5 }, () => tokens.getAccessToken(workspace, id)));
            google.refreshDelayMs = 0;
            expect(google.refreshCalls - before).toBe(1);
            expect(new Set(results).size).toBe(1);
            // A fresh token is handed out without another refresh.
            expect(await tokens.getAccessToken(workspace, id)).toBe(results[0]);
            expect(google.refreshCalls - before).toBe(1);
        });

        it('a grant Google refuses moves the mailbox to reconnect_needed, announced once', async () => {
            const email = `member-${stamp}@example.com`;
            const id = await mailboxIdOf(email);
            await expire(id);
            google.revokeGrantFor(email);
            const before = events.length;
            await expect(tokens.getAccessToken(workspace, id)).rejects.toBeInstanceOf(MailboxUnavailable);
            await expect(tokens.getAccessToken(workspace, id)).rejects.toBeInstanceOf(MailboxUnavailable);
            const after = (await list(admin)).find((m) => m.id === id)!;
            expect(after.status).toBe('reconnect_needed');
            expect(after.lastError?.code).toBe('invalid_grant');
            const announced = events.slice(before);
            expect(announced).toHaveLength(1);
            expect(announced[0]).toMatchObject({
                type: 'mailbox.reconnect_needed',
                recordId: id,
                actor: { kind: 'system' },
            });
        });

        it('connecting it again brings it back, the same row', async () => {
            const again = await connect(member, 'personal', {
                email: `member-${stamp}@example.com`,
                scopes: [...GMAIL_SCOPES],
            });
            expect(again.result).toBe('connected');
            const rows = (await list(admin)).filter((m) => m.email === `member-${stamp}@example.com`);
            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({ status: 'connected', lastError: null });
        });

        it('a check finds a withdrawn scope and moves the mailbox to reconnect_needed', async () => {
            const email = `once-${stamp}@example.com`;
            const id = await mailboxIdOf(email);
            const ok = track(await as(admin).post(w(`/mailboxes/${id}/check`)));
            expect(ok.status).toBe(200);
            expect(ok.body).toMatchObject({ ok: true, problem: null });
            google.narrowGrantFor(email, [GMAIL_SEND_SCOPE]);
            const res = track(await as(admin).post(w(`/mailboxes/${id}/check`)));
            expect(res.body).toMatchObject({
                ok: false,
                problem: 'scope_missing',
                mailbox: { status: 'reconnect_needed' },
            });
        });
    });

    describe('disconnecting', () => {
        it('the client ID cannot change while mailboxes depend on it', async () => {
            const res = track(
                await as(admin)
                    .put(w('/mail/oauth-client'))
                    .send({ clientId: '222-other.apps.googleusercontent.com', clientSecret: 'other' }),
            );
            expect(res.status).toBe(409);
            const removed = track(await as(admin).delete(w('/mail/oauth-client')));
            expect(removed.status).toBe(409);
        });

        it('revokes the grant at Google, wipes the tokens, keeps the row; then the client can go', async () => {
            const before = events.length;
            const revokes = google.revokeCalls;
            const live = (await list(admin)).filter((m) => m.status !== 'disconnected');
            for (const mailbox of live) {
                const res = track(await as(admin).delete(w(`/mailboxes/${mailbox.id}`)));
                expect(res.status).toBe(200);
                expect(res.body).toMatchObject({ revoked: true, mailbox: { status: 'disconnected' } });
            }
            expect(google.revokeCalls - revokes).toBe(live.length);
            expect(events.slice(before).filter((e) => e.type === 'mailbox.disconnected')).toHaveLength(live.length);
            const stored = await owner.$queryRaw<{ n: number }[]>`
                SELECT count(*)::int AS n FROM mailboxes
                WHERE workspace_id = ${workspace}::uuid
                  AND (refresh_token_ciphertext IS NOT NULL OR access_token_ciphertext IS NOT NULL)`;
            expect(stored[0]!.n).toBe(0);
            expect((await list(admin)).every((m) => m.status === 'disconnected')).toBe(true);

            const swapped = track(
                await as(admin)
                    .put(w('/mail/oauth-client'))
                    .send({ clientId: '222-other.apps.googleusercontent.com', clientSecret: 'other-secret-1234' }),
            );
            expect(swapped.status).toBe(200);
            expect(swapped.body).toMatchObject({ verifiedAt: null, lastCheck: null });
            expect(track(await as(admin).delete(w('/mail/oauth-client'))).status).toBe(204);
        });
    });

    it('no token or secret ever appears in a response body or a log line', () => {
        const values = [...google.issued, clientSecret];
        expect(values.length).toBeGreaterThan(10);
        const everything = [...bodies, ...logs].join('\n');
        for (const value of values) expect(everything.includes(value), `leaked ${value.slice(0, 12)}…`).toBe(false);
    });
});

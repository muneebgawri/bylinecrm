import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE, SYSTEM_ROLES } from '@bylinecrm/shared';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_OPTIONS, configureApp } from '../../src/app';
import { AppModule } from '../../src/app.module';
import { verifyPlatformAdminEmail, type VerifiedIdentity } from '../../src/auth/auth.service';
import { OidcService } from '../../src/auth/oidc.service';
import { ENV, parseEnv, type Env } from '../../src/config/env';
import { PrismaService } from '../../src/infra/prisma.service';
import { verifyAddress } from '../support/mail';

/** A signed-in browser: the two cookies and the header a mutation needs. */
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
    if (!session || !csrf) throw new Error('the response did not set both cookies');
    return { cookie: `${session}; ${CSRF_COOKIE}=${csrf}`, csrf };
}

/**
 * Sign-up lockdown (P0-14) end to end against the real application. The environment is one
 * mutable object the application was given in place of the parsed one, so a test can change the
 * sign-up mode or the platform-admin list between requests — which is also how "taken off the
 * list, refused on the next request" is proved: nothing is cached between requests.
 */
describe('sign-up modes and platform admins (P0-14)', () => {
    let app: INestApplication;
    let http: () => request.Agent;
    let owner: PrismaService;
    let env: Env;
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const adminEmail = `platform-${stamp}@example.test`;
    const outsiderEmail = `outsider-${stamp}@example.test`;
    const password = 'correct horse battery staple';
    let admin: Browser;
    let outsider: Browser;
    let outsiderWorkspace: string;
    /** What the stand-in identity provider says the next person to call back is. */
    let nextIdentity: VerifiedIdentity | null = null;
    const fakeOidc = {
        available: () => ['fake'],
        start: () => Promise.resolve(new URL('https://idp.example/authorize')),
        finish: () => {
            if (!nextIdentity) throw new Error('no identity queued for the fake provider');
            return Promise.resolve(nextIdentity);
        },
    };

    const signup = (body: Record<string, unknown>) => http().post('/api/auth/signup').send(body);
    const post = (who: Browser, path: string, body: Record<string, unknown>) =>
        http().post(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf).send(body);

    beforeAll(async () => {
        env = { ...parseEnv(process.env), SIGNUP_MODE: 'open', PLATFORM_ADMIN_EMAILS: [adminEmail] };
        const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
            .overrideProvider(ENV)
            .useValue(env)
            .overrideProvider(OidcService)
            .useValue(fakeOidc)
            .compile();
        app = configureApp(moduleRef.createNestApplication<NestExpressApplication>(APP_OPTIONS));
        await app.init();
        http = () => request(app.getHttpServer() as Parameters<typeof request>[0]);
        owner = app.get(PrismaService);

        // Two accounts made while sign-up is open: the future platform admin and someone else.
        admin = browserFrom(await signup({ email: adminEmail, password, workspaceName: 'Operator' }).expect(201));
        const signedUp = await signup({ email: outsiderEmail, password, workspaceName: 'Outsider Co' }).expect(201);
        outsider = browserFrom(signedUp);
        outsiderWorkspace = (signedUp.body as { workspace: { id: string } }).workspace.id;
        // The outsider proves their mailbox (#93), so its refusals below are about the platform, not
        // verification; the admin stays unverified for the operator-command tests.
        await verifyAddress(app, http, outsiderEmail);
    });

    afterAll(async () => {
        await app.close();
    });

    describe('closed', () => {
        it('refuses sign-up with 403 signup.closed and says so on the providers route', async () => {
            env.SIGNUP_MODE = 'closed';
            const res = await signup({ email: `nobody-${stamp}@example.test`, password, workspaceName: 'X' }).expect(
                403,
            );
            expect(res.body).toMatchObject({ code: 'signup.closed' });
            const providers = await http().get('/api/auth/providers').expect(200);
            expect(providers.body).toMatchObject({ signup: 'closed' });
            expect(await owner.user.count({ where: { email: `nobody-${stamp}@example.test` } })).toBe(0);
        });

        it('refuses POST /api/workspaces to anyone who is not a platform admin', async () => {
            env.SIGNUP_MODE = 'closed';
            const res = await post(outsider, '/api/workspaces', { name: 'Second' }).expect(403);
            expect(res.body).toMatchObject({ code: 'platform.forbidden' });
        });
    });

    describe('platform admin status', () => {
        it('needs a verified address: a listed but unverified account is refused', async () => {
            const res = await http().get('/api/platform/workspaces').set('Cookie', admin.cookie).expect(403);
            expect(res.body).toMatchObject({ code: 'platform.forbidden' });
            const access = await http().get('/api/platform/access').set('Cookie', admin.cookie).expect(200);
            expect(access.body).toMatchObject({ platformAdmin: false });
        });

        it('the operator command verifies only a listed address, and audits it', async () => {
            await expect(verifyPlatformAdminEmail(owner, env, outsiderEmail)).rejects.toThrow(/PLATFORM_ADMIN_EMAILS/);
            expect(await verifyPlatformAdminEmail(owner, env, adminEmail.toUpperCase())).toEqual({
                email: adminEmail,
                alreadyVerified: false,
            });
            const audit = await owner.platformAudit.findMany({ where: { action: 'platform.admin_email_verified' } });
            expect(audit.some((row) => (row.subject as { email?: string }).email === adminEmail)).toBe(true);
            const access = await http().get('/api/platform/access').set('Cookie', admin.cookie).expect(200);
            expect(access.body).toMatchObject({ platformAdmin: true, signupMode: env.SIGNUP_MODE });
        });

        it('platform routes answer 403 to every caller not on the list, and 401 to nobody', async () => {
            await http().get('/api/platform/workspaces').expect(401);
            for (const call of [
                () => http().get('/api/platform/workspaces').set('Cookie', outsider.cookie),
                () => post(outsider, '/api/platform/workspaces', { name: 'Hijack', ownerEmail: outsiderEmail }),
                () => post(outsider, '/api/platform/signup-invites', { email: outsiderEmail }),
            ]) {
                const res = await call().expect(403);
                expect(res.body).toMatchObject({ code: 'platform.forbidden' });
            }
            // A workspace admin's API key is a workspace's, never the platform's.
            const roles = await http().get(`/api/w/${outsiderWorkspace}/roles`).set('Cookie', outsider.cookie);
            const adminRole = (roles.body as { id: string; name: string }[]).find(
                (r) => r.name === SYSTEM_ROLES.admin,
            )!;
            const key = await post(outsider, `/api/w/${outsiderWorkspace}/api-keys`, {
                name: 'ci',
                roleId: adminRole.id,
            });
            const { secret } = key.body as { secret: string };
            await http().get('/api/platform/workspaces').set('Authorization', `Bearer ${secret}`).expect(403);
            await http()
                .post('/api/workspaces')
                .set('Authorization', `Bearer ${secret}`)
                .send({ name: 'By key' })
                .expect(403);
        });

        it('a platform admin may create a workspace of their own in closed mode', async () => {
            env.SIGNUP_MODE = 'closed';
            await post(admin, '/api/workspaces', { name: 'Operator Two' }).expect(201);
        });
    });

    describe('creating a workspace for an owner', () => {
        const ownerEmail = `owner-${stamp}@example.test`;
        let workspaceId: string;
        let token: string;

        it('creates the workspace with its roles and no member, and returns the owner’s invitation', async () => {
            env.SIGNUP_MODE = 'closed';
            const res = await post(admin, '/api/platform/workspaces', { name: 'Client Co', ownerEmail }).expect(201);
            const body = res.body as {
                workspace: { id: string; name: string };
                invite: { email: string; url: string; token: string; expiresAt: string };
            };
            workspaceId = body.workspace.id;
            token = body.invite.token;
            expect(body.workspace.name).toBe('Client Co');
            expect(body.invite.email).toBe(ownerEmail);
            expect(body.invite.url).toBe(`${env.WEB_URL.replace(/\/+$/, '')}/sign-up?invite=${token}`);

            const roles = await owner.role.findMany({ where: { workspaceId }, select: { name: true, isSystem: true } });
            expect(roles.map((r) => r.name).sort()).toEqual([SYSTEM_ROLES.admin, SYSTEM_ROLES.member].sort());
            expect(await owner.workspaceMember.count({ where: { workspaceId } })).toBe(0);
            expect(await owner.pipeline.count({ where: { workspaceId } })).toBeGreaterThan(0);

            const audit = await owner.platformAudit.findMany({ where: { action: 'platform.workspace_created' } });
            const row = audit.find((r) => (r.subject as { workspaceId?: string }).workspaceId === workspaceId);
            expect(row).toMatchObject({ subject: { workspaceId, email: ownerEmail } });
            expect(JSON.stringify(row)).not.toContain(token);
            expect(
                audit.filter((r) => (r.subject as { workspaceId?: string }).workspaceId === workspaceId),
            ).toHaveLength(1);

            const list = await http().get('/api/platform/workspaces').set('Cookie', admin.cookie).expect(200);
            const listed = (
                list.body as { id: string; memberCount: number; pendingInvites: { email: string }[] }[]
            ).find((w) => w.id === workspaceId);
            expect(listed).toMatchObject({ memberCount: 0, pendingInvites: [{ email: ownerEmail }] });
        });

        it('the invitation shows what it is for, to whoever holds it', async () => {
            const res = await http().get(`/api/auth/invites/${token}`).expect(200);
            expect(res.body).toMatchObject({ email: ownerEmail, workspaceName: 'Client Co' });
            await http().get('/api/auth/invites/not-a-token').expect(404);
        });

        it('the owner signs up through it while sign-up is closed and is admin of that workspace only', async () => {
            env.SIGNUP_MODE = 'closed';
            const joined = await http().post(`/api/auth/invites/${token}/signup`).send({ password }).expect(201);
            const ownerBrowser = browserFrom(joined);
            // The invitation was mailed to the owner (#93); the account it creates verifies by a mailed link.
            await verifyAddress(app, http, ownerEmail);
            const mine = await http().get('/api/me/workspaces').set('Cookie', ownerBrowser.cookie).expect(200);
            expect((mine.body as { id: string }[]).map((w) => w.id)).toEqual([workspaceId]);
            const standing = await http()
                .get(`/api/w/${workspaceId}/me`)
                .set('Cookie', ownerBrowser.cookie)
                .expect(200);
            expect(standing.body).toMatchObject({ roleName: SYSTEM_ROLES.admin });
            await http().get(`/api/w/${outsiderWorkspace}/me`).set('Cookie', ownerBrowser.cookie).expect(403);
            // Being a workspace's owner is not being a platform admin.
            await http().get('/api/platform/workspaces').set('Cookie', ownerBrowser.cookie).expect(403);
            await post(ownerBrowser, '/api/workspaces', { name: 'Another' }).expect(403);
            await http().get(`/api/auth/invites/${token}`).expect(410);
        });

        it('an existing, verified account invited as owner accepts with that account', async () => {
            // An account created from an invitation, then verified by its mailed link (#93).
            const existingEmail = `existing-${stamp}@example.test`;
            const first = await post(admin, '/api/platform/workspaces', { name: 'First', ownerEmail: existingEmail });
            const firstToken = (first.body as { invite: { token: string } }).invite.token;
            const existing = browserFrom(
                await http().post(`/api/auth/invites/${firstToken}/signup`).send({ password }).expect(201),
            );
            await verifyAddress(app, http, existingEmail);
            const second = await post(admin, '/api/platform/workspaces', { name: 'Second', ownerEmail: existingEmail });
            const { workspace, invite } = second.body as { workspace: { id: string }; invite: { token: string } };
            await post(existing, `/api/auth/invites/${invite.token}/accept`, {}).expect(200);
            const standing = await http().get(`/api/w/${workspace.id}/me`).set('Cookie', existing.cookie).expect(200);
            expect(standing.body).toMatchObject({ roleName: SYSTEM_ROLES.admin });
        });

        it('the audit is append-only, for the owner connection too', async () => {
            await expect(owner.platformAudit.updateMany({ data: { action: 'tampered' } })).rejects.toThrow(
                /append-only/,
            );
            await expect(owner.platformAudit.deleteMany({})).rejects.toThrow(/append-only/);
        });
    });

    describe('invite', () => {
        const invitedEmail = `invited-${stamp}@example.test`;

        it('needs a valid sign-up invitation for that address', async () => {
            env.SIGNUP_MODE = 'invite';
            const without = await signup({ email: invitedEmail, password, workspaceName: 'Inv' }).expect(403);
            expect(without.body).toMatchObject({ code: 'signup.invitation_required' });
            const bogus = await signup({ email: invitedEmail, password, workspaceName: 'Inv', inviteToken: 'nope' });
            expect(bogus.status).toBe(403);
            expect(bogus.body).toMatchObject({ code: 'signup.invitation_required' });

            const created = await post(admin, '/api/platform/signup-invites', { email: invitedEmail }).expect(201);
            const { token, url } = created.body as { token: string; url: string };
            expect(url).toBe(`${env.WEB_URL.replace(/\/+$/, '')}/sign-up?signup=${token}`);

            // Someone else's invitation is no invitation.
            const other = await signup({
                email: `other-${stamp}@example.test`,
                password,
                workspaceName: 'O',
                inviteToken: token,
            });
            expect(other.status).toBe(403);

            const ok = await signup({ email: invitedEmail, password, workspaceName: 'Inv', inviteToken: token }).expect(
                201,
            );
            // The platform admin saw the same link, so holding it does not verify the address (#93).
            expect(ok.body).toMatchObject({ user: { email: invitedEmail, emailVerified: false } });
            const again = await signup({
                email: `again-${stamp}@example.test`,
                password,
                workspaceName: 'A',
                inviteToken: token,
            });
            expect(again.status).toBe(403);
            expect(
                await owner.platformAudit.count({
                    where: {
                        action: 'platform.signup_invite_created',
                        subject: { path: ['email'], equals: invitedEmail },
                    },
                }),
            ).toBe(1);
        });

        it('refuses POST /api/workspaces to anyone who is not a platform admin', async () => {
            env.SIGNUP_MODE = 'invite';
            const res = await post(outsider, '/api/workspaces', { name: 'Second' }).expect(403);
            expect(res.body).toMatchObject({ code: 'platform.forbidden' });
        });

        it('sign-up invitations are refused outside invite mode', async () => {
            env.SIGNUP_MODE = 'closed';
            await post(admin, '/api/platform/signup-invites', { email: `x-${stamp}@example.test` }).expect(409);
        });
    });

    describe('open', () => {
        it('is unchanged: anyone signs up and anyone signed in may create a workspace', async () => {
            env.SIGNUP_MODE = 'open';
            const res = await signup({
                email: `open-${stamp}@example.test`,
                password,
                workspaceName: 'Open Co',
            }).expect(201);
            expect(res.body).toMatchObject({ user: { emailVerified: false } });
            await post(outsider, '/api/workspaces', { name: 'Second' }).expect(201);
            const providers = await http().get('/api/auth/providers').expect(200);
            expect(providers.body).toMatchObject({ signup: 'open' });
        });
    });

    describe('provider sign-in outside open mode', () => {
        /** Calls back from the fake provider as `email`; the response is the API's redirect. */
        const providerSignIn = (email: string) => {
            nextIdentity = { provider: 'fake', subject: `sub-${email}`, email };
            return http().get('/api/auth/oidc/fake/callback?code=c&state=s');
        };
        const sessionCookie = (res: Response) =>
            ((res.headers['set-cookie'] as string[] | undefined) ?? []).some((c) => c.startsWith(`${SESSION_COOKIE}=`));
        const signInPage = () => `${env.WEB_URL.replace(/\/+$/, '')}/sign-in?error=signup.closed`;

        it('closed: an unknown address gets no account and no session, only the closed-sign-up answer', async () => {
            env.SIGNUP_MODE = 'closed';
            const email = `stranger-${stamp}@example.test`;
            const res = await providerSignIn(email).expect(302);
            expect(res.headers.location).toBe(signInPage());
            expect(sessionCookie(res)).toBe(false);
            expect(await owner.user.count({ where: { email } })).toBe(0);
            expect(await owner.externalIdentity.count({ where: { email } })).toBe(0);
        });

        it('closed: an address with a pending invitation gets its account, in any letter case', async () => {
            env.SIGNUP_MODE = 'closed';
            const email = `invitee-${stamp}@example.test`;
            await post(admin, '/api/platform/workspaces', { name: 'Invitee Co', ownerEmail: email }).expect(201);
            const res = await providerSignIn(email.toUpperCase()).expect(302);
            expect(res.headers.location).toBe(env.WEB_URL);
            expect(sessionCookie(res)).toBe(true);
            expect(await owner.user.count({ where: { email } })).toBe(1);
        });

        it('closed: an expired invitation is no invitation', async () => {
            env.SIGNUP_MODE = 'closed';
            const email = `expired-${stamp}@example.test`;
            const created = await post(admin, '/api/platform/workspaces', { name: 'Late Co', ownerEmail: email });
            const workspaceId = (created.body as { workspace: { id: string } }).workspace.id;
            await owner.workspaceInvite.updateMany({
                where: { workspaceId },
                data: { expiresAt: new Date(Date.now() - 1000) },
            });
            const res = await providerSignIn(email).expect(302);
            expect(res.headers.location).toBe(signInPage());
            expect(await owner.user.count({ where: { email } })).toBe(0);
        });

        it('closed: a listed platform admin with no account yet gets one, verified', async () => {
            env.SIGNUP_MODE = 'closed';
            const email = `second-admin-${stamp}@example.test`;
            env.PLATFORM_ADMIN_EMAILS = [adminEmail, email];
            try {
                const res = await providerSignIn(email).expect(302);
                expect(sessionCookie(res)).toBe(true);
                const user = await owner.user.findUnique({ where: { email } });
                expect(user?.emailVerifiedAt).not.toBeNull();
            } finally {
                env.PLATFORM_ADMIN_EMAILS = [adminEmail];
            }
        });

        it('closed: an existing account signs in as before', async () => {
            env.SIGNUP_MODE = 'closed';
            const res = await providerSignIn(outsiderEmail).expect(302);
            expect(res.headers.location).toBe(env.WEB_URL);
            expect(sessionCookie(res)).toBe(true);
        });

        it('invite: a platform sign-up invitation lets the address in', async () => {
            env.SIGNUP_MODE = 'invite';
            const email = `idp-invited-${stamp}@example.test`;
            await post(admin, '/api/platform/signup-invites', { email }).expect(201);
            const res = await providerSignIn(email).expect(302);
            expect(sessionCookie(res)).toBe(true);
            const refused = await providerSignIn(`idp-nobody-${stamp}@example.test`).expect(302);
            expect(refused.headers.location).toBe(signInPage());
        });

        it('open: unchanged — any verified address gets an account', async () => {
            env.SIGNUP_MODE = 'open';
            const email = `idp-open-${stamp}@example.test`;
            const res = await providerSignIn(email).expect(302);
            expect(sessionCookie(res)).toBe(true);
            expect(await owner.user.count({ where: { email } })).toBe(1);
        });
    });

    describe('revocation', () => {
        it('an address taken off the list is refused on the next request', async () => {
            await http().get('/api/platform/workspaces').set('Cookie', admin.cookie).expect(200);
            env.PLATFORM_ADMIN_EMAILS = [];
            const res = await http().get('/api/platform/workspaces').set('Cookie', admin.cookie).expect(403);
            expect(res.body).toMatchObject({ code: 'platform.forbidden' });
            env.SIGNUP_MODE = 'closed';
            await post(admin, '/api/workspaces', { name: 'After' }).expect(403);
            env.PLATFORM_ADMIN_EMAILS = [adminEmail];
            await http().get('/api/platform/workspaces').set('Cookie', admin.cookie).expect(200);
        });
    });
});

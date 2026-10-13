import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE, SYSTEM_ROLES } from '@bylinecrm/shared';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { LOGIN_MAX_ATTEMPTS } from '../../src/auth/auth.constants';
import { RlsPrismaService } from '../../src/infra/rls-prisma.service';
import { createApp } from '../../src/app';
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
    if (!session || !csrf) throw new Error('login did not set both cookies');
    return { cookie: `${session}; ${CSRF_COOKIE}=${csrf}`, csrf };
}

/**
 * The auth layer end to end against the real application: sign-up, the gates on tenant routes,
 * API keys, invitations, the last-admin rule, CSRF, logout and the login brake. Everything a
 * member of A tries against B must fail before a workspace-scoped query is issued — the spy on
 * `withWorkspace` is the proof.
 */
describe('auth flows', () => {
    let app: INestApplication;
    let http: () => request.Agent;
    let withWorkspace: ReturnType<typeof vi.spyOn>;
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const emailA = `admin-a-${stamp}@example.test`;
    const emailB = `admin-b-${stamp}@example.test`;
    const emailM = `member-${stamp}@example.test`;
    const password = 'correct horse battery staple';
    let a: Browser;
    let b: Browser;
    let workspaceA: string;
    let workspaceB: string;

    beforeAll(async () => {
        app = await createApp();
        await app.init();
        http = () => request(app.getHttpServer());
        withWorkspace = vi.spyOn(app.get(RlsPrismaService), 'withWorkspace');

        const signupA = await http()
            .post('/api/auth/signup')
            .send({ email: emailA, password, workspaceName: 'Alpha Co' })
            .expect(201);
        a = browserFrom(signupA);
        workspaceA = (signupA.body as { workspace: { id: string } }).workspace.id;
        const signupB = await http()
            .post('/api/auth/signup')
            .send({ email: emailB, password, workspaceName: 'Beta Co' })
            .expect(201);
        b = browserFrom(signupB);
        workspaceB = (signupB.body as { workspace: { id: string } }).workspace.id;
        // Both start unverified (#93); `transactional-mail.spec` covers that state. Here they prove their mailboxes.
        await verifyAddress(app, http, emailA);
        await verifyAddress(app, http, emailB);
    });

    afterAll(async () => {
        await app.close();
    });

    it('signs a user up and knows who they are', async () => {
        const me = await http().get('/api/me').set('Cookie', a.cookie).expect(200);
        expect(me.body).toMatchObject({ email: emailA, emailVerified: true });
        const workspaces = await http().get('/api/me/workspaces').set('Cookie', a.cookie).expect(200);
        expect((workspaces.body as { id: string }[]).map((w) => w.id)).toEqual([workspaceA]);
    });

    it('refuses an unauthenticated caller and a bad password with one generic answer', async () => {
        await http().get('/api/me').expect(401);
        const res = await http()
            .post('/api/auth/login')
            .send({ email: emailA, password: 'wrong password here' })
            .expect(401);
        const unknown = await http()
            .post('/api/auth/login')
            .send({ email: `nobody-${stamp}@example.test`, password })
            .expect(401);
        // The same answer either way (no account enumeration); only each request's own id differs.
        const { requestId: _wrong, ...wrongPassword } = res.body as Record<string, unknown>;
        const { requestId: _unknown, ...unknownEmail } = unknown.body as Record<string, unknown>;
        expect(wrongPassword).toEqual(unknownEmail);
        expect(wrongPassword).toMatchObject({ statusCode: 401, code: 'unauthorized' });
    });

    it("refuses a member of A on B's routes before any workspace-scoped query", async () => {
        withWorkspace.mockClear();
        const res = await http().get(`/api/w/${workspaceB}/roles`).set('Cookie', a.cookie).expect(403);
        expect(res.body).toMatchObject({ message: expect.stringMatching(/not a member/) });
        expect(withWorkspace).not.toHaveBeenCalled();
    });

    it('lets an admin see their own roles and members', async () => {
        const roles = await http().get(`/api/w/${workspaceA}/roles`).set('Cookie', a.cookie).expect(200);
        const names = (roles.body as { name: string; isSystem: boolean }[]).map((r) => r.name).sort();
        expect(names).toEqual([SYSTEM_ROLES.admin, SYSTEM_ROLES.member]);
        const members = await http().get(`/api/w/${workspaceA}/members`).set('Cookie', a.cookie).expect(200);
        expect(members.body).toHaveLength(1);
    });

    it('requires the CSRF header on a cookie-authenticated mutation', async () => {
        await http().post('/api/workspaces').set('Cookie', a.cookie).send({ name: 'Second' }).expect(403);
        await http()
            .post('/api/workspaces')
            .set('Cookie', a.cookie)
            .set(CSRF_HEADER, a.csrf)
            .send({ name: 'Second' })
            .expect(201);
    });

    describe('API keys', () => {
        let secret: string;
        let keyId: string;

        it('are created once in full, then listed by prefix only', async () => {
            const roles = await http().get(`/api/w/${workspaceA}/roles`).set('Cookie', a.cookie).expect(200);
            const admin = (roles.body as { id: string; name: string }[]).find((r) => r.name === SYSTEM_ROLES.admin)!;
            const created = await http()
                .post(`/api/w/${workspaceA}/api-keys`)
                .set('Cookie', a.cookie)
                .set(CSRF_HEADER, a.csrf)
                .send({ name: 'ci', roleId: admin.id })
                .expect(201);
            ({ secret } = created.body as { secret: string });
            keyId = (created.body as { key: { id: string } }).key.id;
            expect(secret).toMatch(/^blc_[a-z0-9]{8}_/);
            const listed = await http().get(`/api/w/${workspaceA}/api-keys`).set('Cookie', a.cookie).expect(200);
            // The secret part is base64url and may itself contain `_`; take everything after the head.
            expect(JSON.stringify(listed.body)).not.toContain(secret.replace(/^blc_[a-z0-9]{8}_/, ''));
        });

        it('authenticate as a bearer in their own workspace', async () => {
            await http().get(`/api/w/${workspaceA}/api-keys`).set('Authorization', `Bearer ${secret}`).expect(200);
        });

        it("are refused on another workspace's path before any workspace-scoped query", async () => {
            withWorkspace.mockClear();
            const res = await http()
                .get(`/api/w/${workspaceB}/api-keys`)
                .set('Authorization', `Bearer ${secret}`)
                .expect(403);
            expect(res.body).toMatchObject({ message: expect.stringMatching(/another workspace/) });
            expect(withWorkspace).not.toHaveBeenCalled();
        });

        it('stop working once revoked', async () => {
            await http()
                .delete(`/api/w/${workspaceA}/api-keys/${keyId}`)
                .set('Cookie', a.cookie)
                .set(CSRF_HEADER, a.csrf)
                .expect(204);
            await http().get(`/api/w/${workspaceA}/api-keys`).set('Authorization', `Bearer ${secret}`).expect(401);
        });
    });

    describe('invitations and the member role', () => {
        let m: Browser;
        let memberRoleId: string;
        let adminMemberId: string;

        it('an invited address creates an account from the token and lands in the workspace', async () => {
            const roles = await http().get(`/api/w/${workspaceA}/roles`).set('Cookie', a.cookie).expect(200);
            memberRoleId = (roles.body as { id: string; name: string }[]).find(
                (r) => r.name === SYSTEM_ROLES.member,
            )!.id;
            const invite = await http()
                .post(`/api/w/${workspaceA}/invites`)
                .set('Cookie', a.cookie)
                .set(CSRF_HEADER, a.csrf)
                .send({ email: emailM, roleId: memberRoleId })
                .expect(201);
            const { token } = invite.body as { token: string };
            const joined = await http().post(`/api/auth/invites/${token}/signup`).send({ password }).expect(201);
            m = browserFrom(joined);
            expect((joined.body as { id: string }).id).toBe(workspaceA);
            await http().post(`/api/auth/invites/${token}/signup`).send({ password }).expect(410);
            // The inviter saw the same link, so it proves nothing about the mailbox (#93): a mailed link does.
            const me = await http().get('/api/me').set('Cookie', m.cookie).expect(200);
            expect(me.body).toMatchObject({ email: emailM, emailVerified: false });
            await verifyAddress(app, http, emailM);
        });

        it("#119: an invitation naming a role that is not this workspace's is refused at roleId, never a 500", async () => {
            const rolesB = await http().get(`/api/w/${workspaceB}/roles`).set('Cookie', b.cookie).expect(200);
            const foreignRoleId = (rolesB.body as { id: string; name: string }[]).find(
                (r) => r.name === SYSTEM_ROLES.member,
            )!.id;
            // A role that exists nowhere, and one that exists in another workspace: a foreign key would
            // accept the second (Postgres checks it without row-level security), so the API must refuse it.
            for (const roleId of [crypto.randomUUID(), foreignRoleId]) {
                const res = await http()
                    .post(`/api/w/${workspaceA}/invites`)
                    .set('Cookie', a.cookie)
                    .set(CSRF_HEADER, a.csrf)
                    .send({ email: `nobody-${crypto.randomUUID()}@example.com`, roleId })
                    .expect(422);
                expect(res.body).toMatchObject({
                    code: 'unprocessable',
                    fieldErrors: [{ path: 'roleId' }],
                });
            }
            const invites = await http().get(`/api/w/${workspaceA}/invites`).set('Cookie', a.cookie).expect(200);
            expect((invites.body as { roleId: string }[]).some((i) => i.roleId === foreignRoleId)).toBe(false);
        });

        it('a member can read roles but not change them', async () => {
            await http().get(`/api/w/${workspaceA}/roles`).set('Cookie', m.cookie).expect(200);
            const res = await http()
                .post(`/api/w/${workspaceA}/roles`)
                .set('Cookie', m.cookie)
                .set(CSRF_HEADER, m.csrf)
                .send({ name: 'sales', capabilities: ['deal:read'] })
                .expect(403);
            expect(res.body).toMatchObject({ message: 'requires workspace:admin' });
        });

        it('a role change applies on the next request, with no new token', async () => {
            const members = await http().get(`/api/w/${workspaceA}/members`).set('Cookie', a.cookie).expect(200);
            const rows = members.body as { id: string; email: string }[];
            adminMemberId = rows.find((r) => r.email === emailA)!.id;
            const memberId = rows.find((r) => r.email === emailM)!.id;
            const roles = await http().get(`/api/w/${workspaceA}/roles`).set('Cookie', a.cookie).expect(200);
            const adminRoleId = (roles.body as { id: string; name: string }[]).find(
                (r) => r.name === SYSTEM_ROLES.admin,
            )!.id;
            await http()
                .patch(`/api/w/${workspaceA}/members/${memberId}/role`)
                .set('Cookie', a.cookie)
                .set(CSRF_HEADER, a.csrf)
                .send({ roleId: adminRoleId })
                .expect(204);
            await http()
                .post(`/api/w/${workspaceA}/roles`)
                .set('Cookie', m.cookie)
                .set(CSRF_HEADER, m.csrf)
                .send({ name: 'sales', capabilities: ['deal:read'] })
                .expect(201);
            await http()
                .patch(`/api/w/${workspaceA}/members/${memberId}/role`)
                .set('Cookie', a.cookie)
                .set(CSRF_HEADER, a.csrf)
                .send({ roleId: memberRoleId })
                .expect(204);
        });

        it('the workspace keeps its last admin', async () => {
            await http()
                .delete(`/api/w/${workspaceA}/members/${adminMemberId}`)
                .set('Cookie', a.cookie)
                .set(CSRF_HEADER, a.csrf)
                .expect(409);
            await http()
                .patch(`/api/w/${workspaceA}/members/${adminMemberId}/role`)
                .set('Cookie', a.cookie)
                .set(CSRF_HEADER, a.csrf)
                .send({ roleId: memberRoleId })
                .expect(409);
        });

        it('#147: a removed member keeps their rows and loses access at once; re-invited, the same seat returns', async () => {
            const rows = (await http().get(`/api/w/${workspaceA}/members`).set('Cookie', a.cookie).expect(200))
                .body as { id: string; email: string }[];
            const memberId = rows.find((r) => r.email === emailM)!.id;
            await http()
                .delete(`/api/w/${workspaceA}/members/${memberId}`)
                .set('Cookie', a.cookie)
                .set(CSRF_HEADER, a.csrf)
                .expect(204);
            // Gone from the member list; still named, as "left", wherever their rows show them.
            const after = (await http().get(`/api/w/${workspaceA}/members`).set('Cookie', a.cookie).expect(200))
                .body as { id: string }[];
            expect(after.some((r) => r.id === memberId)).toBe(false);
            const summary = (
                await http().get(`/api/w/${workspaceA}/members/summary`).set('Cookie', a.cookie).expect(200)
            ).body as { memberId: string; leftAt: string | null }[];
            expect(summary.find((s) => s.memberId === memberId)).toMatchObject({ leftAt: expect.any(String) });
            // Their sessions are dead; signed in again, the workspace is not theirs.
            await http().get('/api/me').set('Cookie', m.cookie).expect(401);
            const again = browserFrom(
                await http().post('/api/auth/login').send({ email: emailM, password }).expect(200),
            );
            expect([401, 403]).toContain(
                (await http().get(`/api/w/${workspaceA}/roles`).set('Cookie', again.cookie)).status,
            );
            // Re-invited and accepting while signed in, the same seat comes back — history stays theirs.
            const invite = await http()
                .post(`/api/w/${workspaceA}/invites`)
                .set('Cookie', a.cookie)
                .set(CSRF_HEADER, a.csrf)
                .send({ email: emailM, roleId: memberRoleId })
                .expect(201);
            const accepted = await http()
                .post(`/api/auth/invites/${(invite.body as { token: string }).token}/accept`)
                .set('Cookie', again.cookie)
                .set(CSRF_HEADER, again.csrf);
            expect([200, 201], JSON.stringify(accepted.body)).toContain(accepted.status);
            const back = (await http().get(`/api/w/${workspaceA}/members`).set('Cookie', a.cookie).expect(200))
                .body as { id: string; email: string }[];
            expect(back.find((r) => r.email === emailM)?.id).toBe(memberId);
            m = again;
        });

        it('the admin role cannot be edited and system roles cannot be deleted', async () => {
            const roles = await http().get(`/api/w/${workspaceA}/roles`).set('Cookie', a.cookie).expect(200);
            const admin = (roles.body as { id: string; name: string }[]).find((r) => r.name === SYSTEM_ROLES.admin)!;
            await http()
                .patch(`/api/w/${workspaceA}/roles/${admin.id}`)
                .set('Cookie', a.cookie)
                .set(CSRF_HEADER, a.csrf)
                .send({ capabilities: ['deal:read'] })
                .expect(422);
            await http()
                .delete(`/api/w/${workspaceA}/roles/${admin.id}`)
                .set('Cookie', a.cookie)
                .set(CSRF_HEADER, a.csrf)
                .expect(422);
        });
    });

    it('logs out server-side: the cookie is dead afterwards', async () => {
        await http().post('/api/auth/logout').set('Cookie', b.cookie).set(CSRF_HEADER, b.csrf).expect(204);
        await http().get('/api/me').set('Cookie', b.cookie).expect(401);
    });

    it('brakes repeated failed logins', async () => {
        const email = `brake-${stamp}@example.test`;
        for (let i = 0; i < LOGIN_MAX_ATTEMPTS; i++) {
            await http().post('/api/auth/login').send({ email, password: 'not the password' }).expect(401);
        }
        await http().post('/api/auth/login').send({ email, password: 'not the password' }).expect(429);
    });

    it('serves the OpenAPI document', async () => {
        const res = await http().get('/api/docs-json').expect(200);
        const paths = Object.keys((res.body as { paths: Record<string, unknown> }).paths);
        expect(paths).toEqual(expect.arrayContaining(['/api/auth/login', '/api/me', '/api/w/{workspaceId}/roles']));
    });
});

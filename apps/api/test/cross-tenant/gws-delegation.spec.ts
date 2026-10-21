import 'reflect-metadata';
import { type INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import {
    CSRF_COOKIE,
    CSRF_HEADER,
    DELEGATION_SCOPES,
    GMAIL_READONLY_SCOPE,
    GMAIL_SCOPES,
    GMAIL_SEND_SCOPE,
    GOOGLE_CALENDAR_SCOPE,
    SESSION_COOKIE,
    SYSTEM_ROLES,
} from '@bylinecrm/shared';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_OPTIONS, configureApp } from '../../src/app';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/infra/prisma.service';
import { RlsPrismaService } from '../../src/infra/rls-prisma.service';
import { DelegationService } from '../../src/mail-accounts/delegation.service';
import { GOOGLE_DELEGATION_PORT } from '../../src/mail-accounts/google-delegation.port';
import { GOOGLE_OAUTH_PORT } from '../../src/mail-accounts/google-oauth.port';
import { MAIL_OAUTH_CALLBACK_PATH } from '../../src/mail-accounts/mail-accounts.constants';
import { GMAIL_PORT } from '../../src/mail-sync/gmail.port';
import { MailSyncService } from '../../src/mail-sync/mail-sync.service';
import { FakeGmail } from '../support/fake-gmail';
import { FakeGoogleDelegation, serviceAccountKeyJson } from '../support/fake-google-delegation';
import { FakeGoogleOAuth } from '../support/fake-google-oauth';
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

interface DelegationView {
    configured: boolean;
    clientEmail: string | null;
    clientId: string | null;
    active: boolean;
    grantedScopes: string[];
    scopes: string[];
    delegatedMailboxes: number;
    lastCheck: { subject: string; scopes: { scope: string; granted: boolean; error: string | null }[] } | null;
}
interface DelegationMember {
    memberId: string;
    email: string;
    state: string;
    excluded: boolean;
    mailboxId: string | null;
    mailboxStatus: string | null;
}
interface MailboxView {
    id: string;
    email: string;
    status: string;
    credentialSource: string;
    ownerMemberId: string;
}

/**
 * Google Workspace domain-wide delegation (#225), end to end against a fake Workspace: an admin uploads a
 * service account key (write-only) and the allowed domains; the check reports which scopes the Admin
 * console authorises; every member in an allowed domain without an OAuth connection of their own gets a
 * delegated mailbox that syncs through the service account; their own connection wins; an out-of-domain
 * or excluded member is skipped; every change and sync start is audited; and none of it crosses
 * workspaces or is open to a non-admin.
 */
describe('Google Workspace delegation', () => {
    let app: INestApplication;
    let http: () => request.Agent;
    let owner: PrismaService;
    let rls: RlsPrismaService;
    const google = new FakeGoogleOAuth();
    const gmail = new FakeGmail(google);
    const workspaceGoogle = new FakeGoogleDelegation(google);

    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const domain = `gws-${stamp}.example`;
    const password = 'correct horse battery staple';
    const adminEmail = `admin@${domain}`;
    const syncedEmail = `synced@${domain}`;
    const excludedEmail = `excluded@${domain}`;
    const outsideEmail = `outside-${stamp}@elsewhere.example`;
    const otherEmail = `other-admin-${stamp}@example.com`;
    const clientId = `${Date.now()}`.padEnd(15, '7');
    const keyText = serviceAccountKeyJson(clientId, `sync@byline-${stamp}.iam.gserviceaccount.com`);

    let admin: Browser;
    let synced: Browser;
    let excluded: Browser;
    let outside: Browser;
    let otherAdmin: Browser;
    let workspace: string;
    let otherWorkspace: string;

    const as = (who: Browser) => ({
        get: (path: string) => http().get(path).set('Cookie', who.cookie),
        post: (path: string) => http().post(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
        put: (path: string) => http().put(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
        patch: (path: string) => http().patch(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
        delete: (path: string) => http().delete(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
    });
    const w = (path: string, id = workspace) => `/api/w/${id}${path}`;
    const G = '/mail/google-workspace';

    const members = async () => (await as(admin).get(w(`${G}/members`))).body as DelegationMember[];
    const memberRow = async (email: string) => (await members()).find((m) => m.email === email)!;
    const mailboxAt = (email: string) =>
        owner.mailbox.findUnique({ where: { workspaceId_email: { workspaceId: workspace, email } } });

    beforeAll(async () => {
        const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
            .overrideProvider(GOOGLE_OAUTH_PORT)
            .useValue(google)
            .overrideProvider(GMAIL_PORT)
            .useValue(gmail)
            .overrideProvider(GOOGLE_DELEGATION_PORT)
            .useValue(workspaceGoogle)
            .compile();
        app = configureApp(moduleRef.createNestApplication<NestExpressApplication>(APP_OPTIONS));
        await app.init();
        http = () => request(app.getHttpServer() as Parameters<typeof request>[0]);
        owner = app.get(PrismaService);
        rls = app.get(RlsPrismaService);

        const signUp = async (email: string, name: string) => {
            const res = await http().post('/api/auth/signup').send({ email, password, workspaceName: name });
            expect(res.status).toBe(201);
            await verifyAddress(app, http, email);
            return { browser: browserFrom(res), workspace: (res.body as { workspace: { id: string } }).workspace.id };
        };
        ({ browser: admin, workspace } = await signUp(adminEmail, `GWS ${stamp}`));
        ({ browser: otherAdmin, workspace: otherWorkspace } = await signUp(otherEmail, `Other GWS ${stamp}`));

        const roles = await as(admin).get(w('/roles'));
        const memberRoleId = (roles.body as { id: string; name: string }[]).find(
            (r) => r.name === SYSTEM_ROLES.member,
        )!.id;
        const join = async (email: string) => {
            const invite = await as(admin).post(w('/invites')).send({ email, roleId: memberRoleId });
            const joined = await http()
                .post(`/api/auth/invites/${(invite.body as { token: string }).token}/signup`)
                .send({ password });
            expect(joined.status).toBe(201);
            await verifyAddress(app, http, email);
            return browserFrom(joined);
        };
        synced = await join(syncedEmail);
        excluded = await join(excludedEmail);
        outside = await join(outsideEmail);

        // The Workspace: its users, and the delegation entry a reseller or super admin added.
        workspaceGoogle.addUsers(adminEmail, syncedEmail, excludedEmail, `nobody-in-crm@${domain}`);
        workspaceGoogle.authorise(clientId, DELEGATION_SCOPES);

        // The OAuth client, so a member can still connect their own mailbox.
        const oauthClientId = `333-${stamp.replace(/[^a-z0-9]/g, '')}.apps.googleusercontent.com`;
        const view = await as(admin).get(w('/mail/oauth-client'));
        google.registerClient(oauthClientId, 'GOCSPX-gws', [(view.body as { redirectUri: string }).redirectUri]);
        expect(
            (await as(admin).put(w('/mail/oauth-client')).send({ clientId: oauthClientId, clientSecret: 'GOCSPX-gws' }))
                .status,
        ).toBe(200);
    });

    afterAll(async () => {
        await app?.close();
    });

    it('is closed to non-admins: they can neither read nor replace the key', async () => {
        expect((await as(synced).get(w(G))).status).toBe(403);
        expect((await as(excluded).get(w(G))).status).toBe(403);
        expect(
            (
                await as(synced)
                    .put(w(`${G}/key`))
                    .send({ key: keyText })
            ).status,
        ).toBe(403);
        expect((await as(synced).delete(w(`${G}/key`))).status).toBe(403);
        expect((await as(synced).post(w(`${G}/check`))).status).toBe(403);
        expect((await as(synced).get(w(`${G}/members`))).status).toBe(403);
        expect((await as(synced).get(w(`${G}/audit`))).status).toBe(403);
        expect(await owner.googleWorkspaceDelegation.findUnique({ where: { workspaceId: workspace } })).toBeNull();
    });

    it('refuses a file that is not a service account key', async () => {
        const res = await as(admin)
            .put(w(`${G}/key`))
            .send({ key: '{"type":"authorized_user"}' });
        expect(res.status).toBe(400);
    });

    it('stores the key sealed and write-only, and checks each scope for the admin', async () => {
        const put = await as(admin)
            .put(w(`${G}/key`))
            .send({ key: keyText });
        expect(put.status).toBe(200);
        const view = put.body as DelegationView;
        expect(view).toMatchObject({ configured: true, clientId, active: false });
        expect(view.scopes).toEqual([GMAIL_SEND_SCOPE, GMAIL_READONLY_SCOPE, GOOGLE_CALENDAR_SCOPE]);
        expect(view.lastCheck?.subject).toBe(adminEmail);
        expect(view.lastCheck?.scopes.every((s) => s.granted)).toBe(true);
        // Never the key, in any response, nor in the database in the clear.
        expect(JSON.stringify(put.body)).not.toContain('PRIVATE KEY');
        expect(JSON.stringify((await as(admin).get(w(G))).body)).not.toContain('PRIVATE KEY');
        const row = await owner.googleWorkspaceDelegation.findUniqueOrThrow({ where: { workspaceId: workspace } });
        expect(row.keyCiphertext).not.toContain('PRIVATE KEY');
        // One token per scope, for the admin's own address.
        expect(workspaceGoogle.mints.filter((m) => m.subject === adminEmail).map((m) => m.scopes)).toEqual(
            DELEGATION_SCOPES.map((s) => [s]),
        );
    });

    it('reports a scope the Admin console does not authorise', async () => {
        workspaceGoogle.authorise(clientId, [GMAIL_READONLY_SCOPE, GOOGLE_CALENDAR_SCOPE]);
        const view = (await as(admin).post(w(`${G}/check`))).body as DelegationView;
        expect(view.lastCheck?.scopes.find((s) => s.scope === GMAIL_SEND_SCOPE)).toEqual({
            scope: GMAIL_SEND_SCOPE,
            granted: false,
            error: 'unauthorized_client',
        });
        expect(view.grantedScopes).toEqual([GMAIL_READONLY_SCOPE, GOOGLE_CALENDAR_SCOPE]);
        workspaceGoogle.authorise(clientId, DELEGATION_SCOPES);
        expect(((await as(admin).post(w(`${G}/check`))).body as DelegationView).grantedScopes).toEqual([
            ...DELEGATION_SCOPES,
        ]);
    });

    it('syncs only workspace members in an allowed domain, once a domain is named', async () => {
        expect(await mailboxAt(syncedEmail)).toBeNull();
        const patched = await as(admin)
            .patch(w(G))
            .send({ allowedDomains: [domain.toUpperCase()] });
        expect(patched.status).toBe(200);
        expect(patched.body as DelegationView).toMatchObject({ active: true, delegatedMailboxes: 3 });

        for (const email of [adminEmail, syncedEmail, excludedEmail]) {
            expect(await mailboxAt(email)).toMatchObject({ credentialSource: 'delegation', status: 'connected' });
        }
        // Out of the domain: not synced, connects by OAuth. A Workspace user who is no member: never.
        expect(await mailboxAt(outsideEmail)).toBeNull();
        expect(await mailboxAt(`nobody-in-crm@${domain}`)).toBeNull();
        expect((await memberRow(outsideEmail)).state).toBe('outside_domains');
        expect((await memberRow(syncedEmail)).state).toBe('delegated');

        // The member sees their mailbox as delegated; they cannot disconnect it themselves.
        const own = ((await as(synced).get(w('/mailboxes'))).body as MailboxView[]).find(
            (m) => m.email === syncedEmail,
        )!;
        expect(own.credentialSource).toBe('delegation');
        expect((await as(synced).delete(w(`/mailboxes/${own.id}`))).status).toBe(409);
        expect(((await as(outside).get(w('/mailboxes'))).body as MailboxView[]).length).toBe(0);
    });

    it("syncs an in-domain member's mailbox with a delegated token, cached until it nears expiry", async () => {
        gmail.deliver(syncedEmail, {
            from: `dana-${stamp}@acme.example`,
            to: [syncedEmail],
            subject: 'Delegated hello',
            text: 'hi',
        });
        const mailbox = (await mailboxAt(syncedEmail))!;
        const sync = app.get(MailSyncService);
        const before = workspaceGoogle.mints.filter((m) => m.subject === syncedEmail).length;
        const run = await sync.syncMailbox(workspace, mailbox.id, { sleep: () => Promise.resolve() });
        expect(run.imported).toBe(1);
        const minted = workspaceGoogle.mints.filter((m) => m.subject === syncedEmail);
        expect(minted.length).toBe(before + 1);
        expect(minted.at(-1)!.scopes).toEqual([...DELEGATION_SCOPES]);
        await sync.syncMailbox(workspace, mailbox.id, { sleep: () => Promise.resolve() });
        expect(workspaceGoogle.mints.filter((m) => m.subject === syncedEmail).length).toBe(before + 1);
        const stored = (await mailboxAt(syncedEmail))!;
        expect(stored.accessTokenCiphertext).not.toBeNull();
        expect(stored.refreshTokenCiphertext).toBeNull();

        const audit = await owner.googleWorkspaceDelegationAudit.findMany({
            where: { workspaceId: workspace, action: 'mail_sync_started', mailboxId: mailbox.id },
        });
        expect(audit.length).toBe(2);
    });

    it('skips an excluded member, and brings them back when included', async () => {
        const row = await memberRow(excludedEmail);
        const put = await as(admin)
            .put(w(`${G}/members/${row.memberId}`))
            .send({ excluded: true });
        expect(put.status).toBe(200);
        expect(put.body as DelegationMember).toMatchObject({ state: 'excluded', excluded: true });
        expect((await mailboxAt(excludedEmail))?.status).toBe('disconnected');
        // The worker's reconcile keeps them out.
        await app.get(DelegationService).reconcileAll();
        expect((await mailboxAt(excludedEmail))?.status).toBe('disconnected');
        const back = await as(admin)
            .put(w(`${G}/members/${row.memberId}`))
            .send({ excluded: false });
        expect(back.body as DelegationMember).toMatchObject({ state: 'delegated', mailboxStatus: 'connected' });
        await as(admin)
            .put(w(`${G}/members/${row.memberId}`))
            .send({ excluded: true });
    });

    it("lets a member's own OAuth connection win over delegation", async () => {
        const start = await as(synced).post(w('/mailboxes/connect')).send({ purpose: 'personal' });
        const { code, state } = google.consent((start.body as { authorizeUrl: string }).authorizeUrl, {
            email: syncedEmail,
            scopes: [...GMAIL_SCOPES],
        });
        const callback = await as(synced).get(`${MAIL_OAUTH_CALLBACK_PATH}?state=${state}&code=${code}`);
        expect(new URL(String(callback.headers['location'])).searchParams.get('connect')).toBe('connected');
        const mailbox = (await mailboxAt(syncedEmail))!;
        expect(mailbox).toMatchObject({ credentialSource: 'oauth', status: 'connected' });
        expect((await memberRow(syncedEmail)).state).toBe('own_connection');

        await app.get(DelegationService).reconcileAll();
        expect((await mailboxAt(syncedEmail))?.credentialSource).toBe('oauth');
        const mints = workspaceGoogle.mints.length;
        await app.get(MailSyncService).syncMailbox(workspace, mailbox.id, { sleep: () => Promise.resolve() });
        expect(workspaceGoogle.mints.length).toBe(mints);
    });

    it('audits every key and setting change', async () => {
        const res = await as(admin).get(w(`${G}/audit`));
        expect(res.status).toBe(200);
        const actions = (res.body as { action: string }[]).map((a) => a.action);
        for (const action of [
            'key_set',
            'checked',
            'domains_changed',
            'member_excluded',
            'member_included',
            'mail_sync_started',
        ]) {
            expect(actions).toContain(action);
        }
    });

    it('never crosses workspaces', async () => {
        const view = (await as(otherAdmin).get(w(G, otherWorkspace))).body as DelegationView;
        expect(view).toMatchObject({ configured: false, clientId: null, delegatedMailboxes: 0 });
        expect((await as(otherAdmin).get(w(`${G}/audit`, otherWorkspace))).body).toEqual([]);
        const theirMembers = (await as(otherAdmin).get(w(`${G}/members`, otherWorkspace))).body as DelegationMember[];
        expect(theirMembers.map((m) => m.email)).toEqual([otherEmail]);
        // B's admin cannot act on A's member, nor reach A's routes.
        const aMember = await memberRow(adminEmail);
        expect((await as(otherAdmin).get(w(G))).status).toBe(403);
        const cross = await as(otherAdmin)
            .put(w(`${G}/members/${aMember.memberId}`, otherWorkspace))
            .send({ excluded: true });
        expect(cross.status).toBe(409);
        // Row-level security: B's scope sees none of A's rows.
        await rls.withWorkspace(otherWorkspace, async (tx) => {
            expect(await tx.googleWorkspaceDelegation.findMany()).toEqual([]);
            expect(await tx.googleWorkspaceDelegationAudit.findMany()).toEqual([]);
            expect(await tx.mailbox.count({ where: { credentialSource: 'delegation' } })).toBe(0);
        });
    });

    it('stops every delegated mailbox when the key is removed', async () => {
        expect((await as(admin).delete(w(`${G}/key`))).status).toBe(204);
        expect((await mailboxAt(adminEmail))?.status).toBe('disconnected');
        expect((await mailboxAt(syncedEmail))?.status).toBe('connected');
        const actions = ((await as(admin).get(w(`${G}/audit`))).body as { action: string }[]).map((a) => a.action);
        expect(actions[0]).toBe('key_removed');
    });
});

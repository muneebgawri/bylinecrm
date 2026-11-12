import 'reflect-metadata';
import { type INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE, SYSTEM_ROLES } from '@bylinecrm/shared';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_OPTIONS, configureApp } from '../../src/app';
import { AppModule } from '../../src/app.module';
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

interface Lookup {
    found: boolean;
    match: 'person' | 'company' | null;
    recordId: string | null;
    recordName: string | null;
    owner: { email: string; name: string | null } | null;
}

/**
 * Who owns this person or company (OWN-LOOKUP; NewswireOS doc 11): an integration key with `record:owner_lookup` asks
 * by email and is told the person's owner, else their company's (OWN-2) — found or not, and whose, by sign-in email.
 * Read only, across the key's owner scope, and never across workspaces.
 */
describe('owner lookup for an integration', () => {
    let app: INestApplication;
    let http: () => request.Agent;

    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const password = 'correct horse battery staple';
    const adminEmail = `own-admin-${stamp}@example.com`;
    const memberEmail = `own-member-${stamp}@example.com`;
    const otherEmail = `own-other-${stamp}@example.com`;
    const dana = `dana-${stamp}@gmail.com`;
    const danaWork = `dana.r-${stamp}@hotmail.com`;
    const domain = `acme-${stamp.replace(/[^a-z0-9]/g, '')}.example`;

    let admin: Browser;
    let member: Browser;
    let otherAdmin: Browser;
    let workspace: string;
    let otherWorkspace: string;
    let danaId: string;
    let companyId: string;
    let lookupKey: string;
    let bareKey: string;
    let otherKey: string;

    const as = (who: Browser) => ({
        get: (path: string) => http().get(path).set('Cookie', who.cookie),
        post: (path: string) => http().post(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
    });
    const w = (path: string, id = workspace) => `/api/w/${id}${path}`;
    const lookup = (key: string, query: Record<string, string>, ws = workspace) =>
        http()
            .get(w(`/integrations/owners/lookup?${new URLSearchParams(query)}`, ws))
            .set('Authorization', `Bearer ${key}`);

    async function keyWith(who: Browser, ws: string, name: string, capabilities: string[]): Promise<string> {
        const role = await as(who)
            .post(w('/roles', ws))
            .send({ name: `${name} ${stamp}`, recordScope: 'all', capabilities });
        expect(role.status, JSON.stringify(role.body)).toBe(201);
        const key = await as(who)
            .post(w('/api-keys', ws))
            .send({ name: `${name}-${stamp}`, roleId: (role.body as { id: string }).id });
        expect(key.status).toBe(201);
        return (key.body as { secret: string }).secret;
    }

    beforeAll(async () => {
        const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
        app = configureApp(moduleRef.createNestApplication<NestExpressApplication>(APP_OPTIONS));
        await app.init();
        http = () => request(app.getHttpServer() as Parameters<typeof request>[0]);

        const signUp = async (email: string, name: string) => {
            const res = await http().post('/api/auth/signup').send({ email, password, workspaceName: name });
            expect(res.status).toBe(201);
            await verifyAddress(app, http, email);
            return { browser: browserFrom(res), workspace: (res.body as { workspace: { id: string } }).workspace.id };
        };
        ({ browser: admin, workspace } = await signUp(adminEmail, `Owners ${stamp}`));
        ({ browser: otherAdmin, workspace: otherWorkspace } = await signUp(otherEmail, `Other owners ${stamp}`));

        const roles = await as(admin).get(w('/roles'));
        const memberRoleId = (roles.body as { id: string; name: string }[]).find(
            (r) => r.name === SYSTEM_ROLES.member,
        )!.id;
        const invite = await as(admin).post(w('/invites')).send({ email: memberEmail, roleId: memberRoleId });
        const joined = await http()
            .post(`/api/auth/invites/${(invite.body as { token: string }).token}/signup`)
            .send({ password });
        expect(joined.status).toBe(201);
        await verifyAddress(app, http, memberEmail);
        member = browserFrom(joined);

        // Dana is the admin's lead (free-mail addresses: no company by domain).
        const person = await as(admin)
            .post(w('/people'))
            .send({ nameFirst: 'Dana', nameLast: 'Reyes', emails: { primary: dana, additional: [danaWork] } });
        expect(person.status, JSON.stringify(person.body)).toBe(201);
        danaId = (person.body as { id: string }).id;

        // Acme is the member's account: everyone at its domain is theirs (OWN-2).
        const company = await as(member)
            .post(w('/companies'))
            .send({ name: `Acme ${stamp}`, domain });
        expect(company.status, JSON.stringify(company.body)).toBe(201);
        companyId = (company.body as { id: string }).id;

        lookupKey = await keyWith(admin, workspace, 'newswireos', ['record:owner_lookup']);
        bareKey = await keyWith(admin, workspace, 'nothing', ['record:read']);
        otherKey = await keyWith(otherAdmin, otherWorkspace, 'other', ['record:owner_lookup']);
    });

    afterAll(async () => {
        await app?.close();
    });

    it("OWN-LOOKUP: a person's primary or additional email answers with the person and their owner", async () => {
        for (const email of [dana, danaWork.toUpperCase()]) {
            const res = await lookup(lookupKey, { email });
            expect(res.status, JSON.stringify(res.body)).toBe(200);
            expect(res.body as Lookup).toEqual({
                found: true,
                match: 'person',
                recordId: danaId,
                recordName: 'Dana Reyes',
                owner: { email: adminEmail, name: expect.anything() },
            });
        }
    });

    it("OWN-LOOKUP: nobody with the address, but a company at its domain: the company's owner", async () => {
        const res = await lookup(lookupKey, { email: `new.signup-${stamp}@${domain}` });
        expect(res.status).toBe(200);
        expect(res.body as Lookup).toMatchObject({
            found: true,
            match: 'company',
            recordId: companyId,
            owner: { email: memberEmail },
        });
        // A free-mail address names its company domain explicitly.
        const byDomain = await lookup(lookupKey, { email: `someone-${stamp}@gmail.com`, domain });
        expect(byDomain.body as Lookup).toMatchObject({ match: 'company', owner: { email: memberEmail } });
    });

    it('OWN-LOOKUP: nothing known is "not found", not an error', async () => {
        const res = await lookup(lookupKey, { email: `stranger-${stamp}@gmail.com` });
        expect(res.status).toBe(200);
        expect(res.body as Lookup).toEqual({
            found: false,
            match: null,
            recordId: null,
            recordName: null,
            owner: null,
        });
    });

    it('OWN-LOOKUP: only a key holding record:owner_lookup may ask, and never about another workspace', async () => {
        expect((await lookup(bareKey, { email: dana })).status).toBe(403);
        // The other workspace's key, in its own workspace: Dana is not there.
        const theirs = await lookup(otherKey, { email: dana }, otherWorkspace);
        expect(theirs.body as Lookup).toMatchObject({ found: false, owner: null });
        // And it cannot ask in ours.
        expect([401, 403, 404]).toContain((await lookup(otherKey, { email: dana })).status);
    });

    it('OWN-LOOKUP: a malformed address is refused', async () => {
        expect((await lookup(lookupKey, { email: 'not-an-address' })).status).toBe(400);
    });
});

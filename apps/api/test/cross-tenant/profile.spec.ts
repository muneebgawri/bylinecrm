import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE } from '@bylinecrm/shared';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RlsPrismaService } from '../../src/infra/rls-prisma.service';
import { createApp } from '../../src/app';

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
    if (!session || !csrf) throw new Error('sign-up did not set both cookies');
    return { cookie: `${session}; ${CSRF_COOKIE}=${csrf}`, csrf };
}

interface Profile {
    email: string;
    displayName: string | null;
    completed: boolean;
}
interface MemberSummary {
    memberId: string;
    name: string | null;
}

/**
 * The display name is the person's, set once and read everywhere a member is named (P1-UI-10,
 * exit-check item 11): the members summary every picker reads, the owner embedded on a row, every
 * workspace the person belongs to. Only the person can change it — the route has no id in it, and
 * the `users` policy lets the app role update one row: the caller's.
 */
describe('profile: the display name (exit check 11)', () => {
    let app: INestApplication;
    let http: () => request.Agent;
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const password = 'correct horse battery staple';
    let kate: Browser;
    let sam: Browser;
    let kateUserId: string;
    let workspace: string;

    const as = (who: Browser) => ({
        get: (path: string) => http().get(path).set('Cookie', who.cookie),
        post: (path: string) => http().post(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
        patch: (path: string) => http().patch(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
    });
    const w = (path: string) => `/api/w/${workspace}${path}`;

    beforeAll(async () => {
        app = await createApp();
        await app.init();
        http = () => request(app.getHttpServer());

        const signup = await http()
            .post('/api/auth/signup')
            .send({ email: `kate.morgan-${stamp}@example.test`, password, workspaceName: 'Profile Co' })
            .expect(201);
        kate = browserFrom(signup);
        workspace = (signup.body as { workspace: { id: string } }).workspace.id;
        kateUserId = (signup.body as { user: { id: string } }).user.id;

        const other = await http()
            .post('/api/auth/signup')
            .send({ email: `sam-${stamp}@example.test`, password, workspaceName: 'Elsewhere Co' })
            .expect(201);
        sam = browserFrom(other);
    });

    afterAll(async () => {
        await app.close();
    });

    it('a new account starts with its address local part, not yet confirmed', async () => {
        const res = await as(kate).get('/api/me/profile').expect(200);
        expect(res.body).toEqual<Profile>({
            email: `kate.morgan-${stamp}@example.test`,
            displayName: `kate.morgan-${stamp}`,
            completed: false,
        });
    });

    it('PATCH sets the name, trimmed, and confirms the profile', async () => {
        const res = await as(kate).patch('/api/me/profile').send({ displayName: '  Kate Morgan  ' }).expect(200);
        expect(res.body).toMatchObject({ displayName: 'Kate Morgan', completed: true });
        const again = await as(kate).get('/api/me/profile').expect(200);
        expect((again.body as Profile).displayName).toBe('Kate Morgan');
    });

    it('refuses an empty name and one over 80 characters, naming the field', async () => {
        const empty = await as(kate).patch('/api/me/profile').send({ displayName: '   ' }).expect(400);
        expect(empty.body).toMatchObject({ code: 'validation.failed' });
        expect((empty.body as { fieldErrors: { path: string }[] }).fieldErrors[0]?.path).toBe('displayName');
        await as(kate)
            .patch('/api/me/profile')
            .send({ displayName: 'x'.repeat(81) })
            .expect(400);
    });

    it('the members summary and an owned row read the same name', async () => {
        const summary = await as(kate).get(w('/members/summary')).expect(200);
        expect((summary.body as MemberSummary[]).map((m) => m.name)).toContain('Kate Morgan');

        await as(kate).post(w('/people')).send({ nameFirst: 'Dana', nameLast: 'Reyes' }).expect(201);
        const people = await as(kate).get(w('/people')).expect(200);
        const row = (people.body as { items: { owner: { name: string | null } | null }[] }).items[0];
        expect(row?.owner?.name).toBe('Kate Morgan');
    });

    it('the name follows the person into every workspace they belong to', async () => {
        const created = await as(kate).post('/api/workspaces').send({ name: 'Second Co' }).expect(201);
        const second = (created.body as { id: string }).id;
        const summary = await as(kate).get(`/api/w/${second}/members/summary`).expect(200);
        expect((summary.body as MemberSummary[]).map((m) => m.name)).toEqual(['Kate Morgan']);
    });

    it("another person's PATCH changes only their own name", async () => {
        await as(sam).patch('/api/me/profile').send({ displayName: 'Sam Okafor' }).expect(200);
        const kates = await as(kate).get('/api/me/profile').expect(200);
        expect((kates.body as Profile).displayName).toBe('Kate Morgan');
    });

    it("the policy lets the app role update the caller's own row and no other", async () => {
        const rls = app.get(RlsPrismaService);
        const strangerId = '00000000-0000-4000-8000-0000000000ff';
        const touched = await rls.withUser(strangerId, (tx) =>
            tx.user.updateMany({ where: { id: kateUserId }, data: { displayName: 'Hijacked' } }),
        );
        expect(touched.count).toBe(0);
        const kates = await as(kate).get('/api/me/profile').expect(200);
        expect((kates.body as Profile).displayName).toBe('Kate Morgan');
    });
});

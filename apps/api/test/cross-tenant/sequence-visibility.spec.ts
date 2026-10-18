import 'reflect-metadata';
import { type INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE, type SequenceView } from '@bylinecrm/shared';
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

/**
 * Who sees a sequence (#192): its owner — the member who made it — marks it **private** (the owner
 * and admins only) or **shared** (everyone who may enrol, the default, as every sequence was
 * before). A private sequence is invisible to other members everywhere a member reaches it: the
 * list, opening it, changing it, its enrolments and enrolling into it. Only the owner or an admin
 * changes who sees it. And one workspace never sees another's.
 */
describe('#192 sequence visibility: private or shared', () => {
    let app: INestApplication;
    let http: () => request.Agent;
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const password = 'correct horse battery staple';
    let admin: Browser;
    let ana: Browser;
    let ben: Browser;
    let other: Browser;
    let workspace: string;
    let otherWorkspace: string;
    let anaMemberId: string;
    let person: string;

    const as = (who: Browser) => ({
        get: (path: string) => http().get(path).set('Cookie', who.cookie),
        post: (path: string) => http().post(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
        patch: (path: string) => http().patch(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
        put: (path: string) => http().put(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
    });
    const w = (path: string, id = workspace) => `/api/w/${id}${path}`;
    const create = async (who: Browser, body: Record<string, unknown>): Promise<SequenceView> => {
        const res = await as(who).post(w('/sequences')).send(body);
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        return res.body as SequenceView;
    };
    const listed = async (who: Browser, ws = workspace): Promise<string[]> =>
        ((await as(who).get(w('/sequences', ws)).expect(200)).body as SequenceView[]).map((s) => s.id);

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
        ({ browser: admin, workspace } = await signUp(`seqvis-admin-${stamp}@example.test`, `Seq vis ${stamp}`));
        ({ browser: other, workspace: otherWorkspace } = await signUp(
            `seqvis-other-${stamp}@example.test`,
            `Seq vis other ${stamp}`,
        ));

        // Account managers: they run their own outreach (write and enrol), and are no admins.
        const role = await as(admin)
            .post(w('/roles'))
            .send({
                name: 'account manager',
                capabilities: ['record:read', 'record:write', 'sequence:write', 'sequence:enrol', 'template:read'],
            })
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
        ana = await join(`seqvis-ana-${stamp}@example.test`);
        ben = await join(`seqvis-ben-${stamp}@example.test`);
        const members = (await as(admin).get(w('/members')).expect(200)).body as { id: string; email: string }[];
        anaMemberId = members.find((m) => m.email === `seqvis-ana-${stamp}@example.test`)!.id;
        person = (
            (await as(admin).post(w('/people')).send({ nameFirst: 'Pat', nameLast: 'Prospect' }).expect(201)).body as {
                id: string;
            }
        ).id;
    });

    afterAll(async () => {
        await app?.close();
    });

    it('a new sequence is its maker’s and shared by default: every member who may enrol sees it', async () => {
        const shared = await create(ana, { name: `Shared ${stamp}` });
        expect(shared).toMatchObject({ ownerMemberId: anaMemberId, visibility: 'shared' });
        expect(await listed(ben)).toContain(shared.id);
        expect((await as(ben).get(w(`/sequences/${shared.id}`))).status).toBe(200);
    });

    it('a private sequence is its owner’s and the admins’ only: to anyone else it does not exist', async () => {
        const mine = await create(ana, { name: `Private ${stamp}`, visibility: 'private' });
        expect(mine).toMatchObject({ ownerMemberId: anaMemberId, visibility: 'private' });
        expect(await listed(ana)).toContain(mine.id);
        expect(await listed(admin)).toContain(mine.id);
        expect((await as(admin).get(w(`/sequences/${mine.id}`))).status).toBe(200);

        expect(await listed(ben)).not.toContain(mine.id);
        expect((await as(ben).get(w(`/sequences/${mine.id}`))).status).toBe(404);
        expect(
            (
                await as(ben)
                    .patch(w(`/sequences/${mine.id}`))
                    .send({ name: 'Mine now' })
            ).status,
        ).toBe(404);
        expect(
            (
                await as(ben)
                    .put(w(`/sequences/${mine.id}/steps`))
                    .send({ steps: [{ kind: 'wait', waitDays: 2 }] })
            ).status,
        ).toBe(404);
        expect((await as(ben).post(w(`/sequences/${mine.id}/archive`))).status).toBe(404);
        expect((await as(ben).get(w(`/sequences/${mine.id}/enrolments`))).status).toBe(404);
        expect(
            (
                await as(ben)
                    .post(w(`/sequences/${mine.id}/enrolments/preview`))
                    .send({ personIds: [person] })
            ).status,
        ).toBe(404);
        expect(
            (
                await as(ben)
                    .post(w(`/sequences/${mine.id}/enrolments`))
                    .send({ personIds: [person] })
            ).status,
        ).toBe(404);
        // The name was never changed under the owner.
        expect(
            (
                (
                    await as(ana)
                        .get(w(`/sequences/${mine.id}`))
                        .expect(200)
                ).body as SequenceView
            ).name,
        ).toBe(`Private ${stamp}`);
    });

    it('only the owner or an admin changes who sees it', async () => {
        const s = await create(ana, { name: `Switch ${stamp}` });
        // Another member may edit a shared sequence as before, but not hide it from its owner's colleagues.
        expect(
            (
                await as(ben)
                    .patch(w(`/sequences/${s.id}`))
                    .send({ name: `Switch ${stamp} (edited)` })
            ).status,
        ).toBe(200);
        const refused = await as(ben)
            .patch(w(`/sequences/${s.id}`))
            .send({ visibility: 'private' });
        expect(refused.status).toBe(403);
        expect(await listed(ben)).toContain(s.id);

        expect(
            (
                (
                    await as(ana)
                        .patch(w(`/sequences/${s.id}`))
                        .send({ visibility: 'private' })
                        .expect(200)
                ).body as SequenceView
            ).visibility,
        ).toBe('private');
        expect(await listed(ben)).not.toContain(s.id);
        expect(
            (
                (
                    await as(admin)
                        .patch(w(`/sequences/${s.id}`))
                        .send({ visibility: 'shared' })
                        .expect(200)
                ).body as SequenceView
            ).visibility,
        ).toBe('shared');
        expect(await listed(ben)).toContain(s.id);
    });

    it('another workspace sees none of them, shared or private', async () => {
        const shared = await create(ana, { name: `Cross shared ${stamp}` });
        const hidden = await create(ana, { name: `Cross private ${stamp}`, visibility: 'private' });
        const theirs = await listed(other, otherWorkspace);
        expect(theirs).not.toContain(shared.id);
        expect(theirs).not.toContain(hidden.id);
        for (const id of [shared.id, hidden.id]) {
            expect((await as(other).get(w(`/sequences/${id}`, otherWorkspace))).status).toBe(404);
            expect((await as(other).get(w(`/sequences/${id}`))).status).toBe(403);
        }
    });
});

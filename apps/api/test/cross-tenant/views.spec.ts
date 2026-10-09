import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import {
    CSRF_COOKIE,
    CSRF_HEADER,
    SESSION_COOKIE,
    type FilterGroup,
    type SavedView,
    type SearchResults,
} from '@bylinecrm/shared';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
    if (!session || !csrf) throw new Error('login did not set both cookies');
    return { cookie: `${session}; ${CSRF_COOKIE}=${csrf}`, csrf };
}

interface Page<T> {
    items: T[];
    nextCursor: string | null;
}
interface Person {
    id: string;
    nameFirst: string;
    nameLast: string;
    ownerId: string | null;
    custom: Record<string, unknown>;
}
interface Group {
    value: unknown;
    count: number;
    sum?: { amountMinor: number; field: string };
}

const encode = (filter: FilterGroup) => Buffer.from(JSON.stringify(filter)).toString('base64url');

/**
 * Filters, sorts, saved views, group-by, CSV export and global search end to end: every one of
 * them under the owner-scope rule and the workspace boundary, which is where a query feature
 * leaks if it is going to.
 */
describe('views, filters, export and search', () => {
    let app: INestApplication;
    let http: () => request.Agent;
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    /** A token the text search can find and nothing else in the database carries. */
    const token = `zq${stamp.replace(/[^a-z0-9]/gi, '')}`;
    const password = 'correct horse battery staple';
    let admin: Browser;
    let rep: Browser;
    let other: Browser;
    let workspace: string;
    let otherWorkspace: string;
    let adminMemberId: string;
    let repMemberId: string;
    let adminsPerson: string;
    let adminsOther: string;
    let repsPerson: string;

    const as = (who: Browser) => ({
        get: (path: string) => http().get(path).set('Cookie', who.cookie),
        post: (path: string) => http().post(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
        patch: (path: string) => http().patch(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
        delete: (path: string) => http().delete(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
    });
    const w = (path: string) => `/api/w/${workspace}${path}`;
    const ids = (res: Response) => (res.body as Page<Person>).items.map((p) => p.id);

    beforeAll(async () => {
        app = await createApp();
        await app.init();
        http = () => request(app.getHttpServer());

        const signup = await http()
            .post('/api/auth/signup')
            .send({ email: `admin-${stamp}@example.test`, password, workspaceName: 'Views Co' })
            .expect(201);
        admin = browserFrom(signup);
        workspace = (signup.body as { workspace: { id: string } }).workspace.id;

        const otherSignup = await http()
            .post('/api/auth/signup')
            .send({ email: `other-${stamp}@example.test`, password, workspaceName: 'Elsewhere Co' })
            .expect(201);
        other = browserFrom(otherSignup);
        otherWorkspace = (otherSignup.body as { workspace: { id: string } }).workspace.id;

        const role = await as(admin)
            .post(w('/roles'))
            .send({
                name: 'rep',
                capabilities: ['record:read', 'record:write', 'deal:read', 'view:save'],
                recordScope: 'own',
            })
            .expect(201);
        const invite = await as(admin)
            .post(w('/invites'))
            .send({ email: `rep-${stamp}@example.test`, roleId: (role.body as { id: string }).id })
            .expect(201);
        rep = browserFrom(
            await http()
                .post(`/api/auth/invites/${(invite.body as { token: string }).token}/signup`)
                .send({ password })
                .expect(201),
        );
        const members = await as(admin).get(w('/members')).expect(200);
        const byEmail = new Map((members.body as { id: string; email: string }[]).map((m) => [m.email, m.id] as const));
        adminMemberId = byEmail.get(`admin-${stamp}@example.test`)!;
        repMemberId = byEmail.get(`rep-${stamp}@example.test`)!;

        await as(admin)
            .post(w('/custom-fields'))
            .send({ object: 'person', key: 'beat', label: 'Beat', type: 'select', options: ['fintech', 'health'] })
            .expect(201);
        await as(admin)
            .post(w('/custom-fields'))
            .send({ object: 'person', key: 'score', label: 'Score', type: 'number' })
            .expect(201);

        const a1 = await as(admin)
            .post(w('/people'))
            .send({ nameFirst: token, nameLast: 'Fintech', city: 'Austin', custom: { beat: 'fintech', score: 9 } })
            .expect(201);
        adminsPerson = (a1.body as Person).id;
        const a2 = await as(admin)
            .post(w('/people'))
            .send({ nameFirst: '=HYPERLINK("x")', nameLast: 'Noscore', city: 'Boston' })
            .expect(201);
        adminsOther = (a2.body as Person).id;
        const r1 = await as(rep)
            .post(w('/people'))
            .send({ nameFirst: token, nameLast: 'Health', city: 'Austin', custom: { beat: 'health', score: 3 } })
            .expect(201);
        repsPerson = (r1.body as Person).id;
    });

    afterAll(async () => {
        await app.close();
    });

    describe('filters on a list', () => {
        it('a custom select, a null check and a text prefix — each under the caller’s scope', async () => {
            const fintech = encode({ and: [{ field: 'custom.beat', op: 'eq', value: 'fintech' }] });
            expect(
                ids(
                    await as(admin)
                        .get(w(`/people?filter=${fintech}`))
                        .expect(200),
                ),
            ).toEqual([adminsPerson]);
            // The rep owns no fintech person: an empty page, never the admin's.
            expect(
                ids(
                    await as(rep)
                        .get(w(`/people?filter=${fintech}`))
                        .expect(200),
                ),
            ).toEqual([]);

            const noBeat = encode({ and: [{ field: 'custom.beat', op: 'is_null' }] });
            expect(
                ids(
                    await as(admin)
                        .get(w(`/people?filter=${noBeat}`))
                        .expect(200),
                ),
            ).toEqual([adminsOther]);

            const austin = encode({ and: [{ field: 'city', op: 'starts', value: 'aus' }] });
            expect(
                ids(
                    await as(admin)
                        .get(w(`/people?filter=${austin}`))
                        .expect(200),
                ).sort(),
            ).toEqual([adminsPerson, repsPerson].sort());
            expect(
                ids(
                    await as(rep)
                        .get(w(`/people?filter=${austin}`))
                        .expect(200),
                ),
            ).toEqual([repsPerson]);

            const highScore = encode({
                or: [
                    { field: 'custom.score', op: 'gte', value: 5 },
                    { field: 'city', op: 'eq', value: 'Boston' },
                ],
            });
            expect(
                ids(
                    await as(admin)
                        .get(w(`/people?filter=${highScore}`))
                        .expect(200),
                ).sort(),
            ).toEqual([adminsPerson, adminsOther].sort());
        });

        it('the body twin takes the same filter as JSON', async () => {
            const res = await as(admin)
                .post(w('/people/query'))
                .send({ filter: { and: [{ field: 'custom.beat', op: 'eq', value: 'health' }] }, limit: 10 })
                .expect(200);
            expect(ids(res)).toEqual([repsPerson]);
        });

        it('a bad filter is refused with the reason', async () => {
            const unknown = encode({ and: [{ field: 'custom.nope', op: 'eq', value: 1 }] });
            const res = await as(admin)
                .get(w(`/people?filter=${unknown}`))
                .expect(400);
            expect((res.body as { message: string }).message).toContain('custom field "nope"');
            await as(admin).get(w('/people?filter=not-json')).expect(400);
            const wrongType = encode({ and: [{ field: 'custom.score', op: 'eq', value: 'nine' }] });
            await as(admin)
                .get(w(`/people?filter=${wrongType}`))
                .expect(400);
        });

        it('sorts by several fields, and refuses a custom or unknown one', async () => {
            const res = await as(admin).get(w('/people?sort=nameLast:asc,nameFirst:desc')).expect(200);
            const lasts = (res.body as Page<Person>).items.map((p) => p.nameLast);
            expect(lasts).toEqual([...lasts].sort());
            await as(admin).get(w('/people?sort=custom.beat:asc')).expect(400);
            await as(admin).get(w('/people?sort=secret:asc')).expect(400);
        });
    });

    describe('saved views', () => {
        let repsView: string;
        let sharedView: string;

        it('a member saves a private view only they can see', async () => {
            const created = await as(rep)
                .post(w('/views'))
                .send({
                    object: 'person',
                    name: 'Austin',
                    filter: { and: [{ field: 'city', op: 'starts', value: 'Aus' }] },
                    sorts: [{ field: 'nameLast', direction: 'asc' }],
                    columns: [{ field: 'nameFirst' }, { field: 'custom.beat', width: 160 }],
                })
                .expect(201);
            const view = created.body as SavedView;
            repsView = view.id;
            expect(view.ownerMemberId).toBe(repMemberId);
            expect(view.isShared).toBe(false);

            const adminSees = (await as(admin).get(w('/views?object=person')).expect(200)).body as SavedView[];
            expect(adminSees.map((v) => v.id)).not.toContain(repsView);
            await as(admin)
                .get(w(`/views/${repsView}`))
                .expect(404);
            await as(other).get(`/api/w/${otherWorkspace}/views/${repsView}`).expect(404);
        });

        it('sharing needs view:share; a shared view is seen by everyone and edited only by sharers', async () => {
            await as(rep).post(w('/views')).send({ object: 'person', name: 'Nope', isShared: true }).expect(403);
            await as(rep)
                .patch(w(`/views/${repsView}`))
                .send({ isShared: true })
                .expect(403);

            const created = await as(admin)
                .post(w('/views'))
                .send({
                    object: 'person',
                    name: 'Fintech beat',
                    isShared: true,
                    filter: { and: [{ field: 'custom.beat', op: 'eq', value: 'fintech' }] },
                })
                .expect(201);
            sharedView = (created.body as SavedView).id;
            const repSees = (await as(rep).get(w('/views?object=person')).expect(200)).body as SavedView[];
            expect(repSees.map((v) => v.id).sort()).toEqual([repsView, sharedView].sort());
            await as(rep)
                .patch(w(`/views/${sharedView}`))
                .send({ name: 'Mine now' })
                .expect(403);
            await as(rep)
                .delete(w(`/views/${sharedView}`))
                .expect(403);

            const copy = (
                await as(rep)
                    .post(w(`/views/${sharedView}/duplicate`))
                    .expect(201)
            ).body as SavedView;
            expect(copy.isShared).toBe(false);
            expect(copy.ownerMemberId).toBe(repMemberId);
            expect(copy.name).toBe('Fintech beat (copy)');
        });

        it('a view that names a field the object lacks is refused on save', async () => {
            await as(admin)
                .post(w('/views'))
                .send({
                    object: 'company',
                    name: 'Bad',
                    filter: { and: [{ field: 'custom.beat', op: 'eq', value: 'x' }] },
                })
                .expect(400);
            await as(admin)
                .post(w('/views'))
                .send({ object: 'person', name: 'Bad sort', sorts: [{ field: 'custom.beat', direction: 'asc' }] })
                .expect(400);
            await as(admin)
                .post(w('/views'))
                .send({ object: 'person', name: 'Bad group', groupBy: 'nameFirst' })
                .expect(400);
        });

        it('a list takes a view as its defaults, and inline parameters override them', async () => {
            expect(
                ids(
                    await as(admin)
                        .get(w(`/people?view=${sharedView}`))
                        .expect(200),
                ),
            ).toEqual([adminsPerson]);
            // The rep uses the shared view: its filter, under the rep's scope.
            expect(
                ids(
                    await as(rep)
                        .get(w(`/people?view=${sharedView}`))
                        .expect(200),
                ),
            ).toEqual([]);
            const override = encode({ and: [{ field: 'custom.beat', op: 'eq', value: 'health' }] });
            expect(
                ids(
                    await as(rep)
                        .get(w(`/people?view=${sharedView}&filter=${override}`))
                        .expect(200),
                ),
            ).toEqual([repsPerson]);
            // The rep's private view is not a view the admin can name.
            await as(admin)
                .get(w(`/people?view=${repsView}`))
                .expect(404);
        });
    });

    describe('group-by', () => {
        it('counts per owner over the scoped list', async () => {
            const groups = (await as(admin).get(w('/people/group-by?field=ownerId')).expect(200)).body as Group[];
            const byOwner = new Map(groups.map((g) => [g.value, g.count]));
            expect(byOwner.get(adminMemberId)).toBe(2);
            expect(byOwner.get(repMemberId)).toBe(1);

            const repGroups = (await as(rep).get(w('/people/group-by?field=ownerId')).expect(200)).body as Group[];
            expect(repGroups).toEqual([{ value: repMemberId, count: 1 }]);

            await as(admin).get(w('/people/group-by?field=nameFirst')).expect(400);
        });

        it('sums deal amounts per currency', async () => {
            await as(admin)
                .post(w('/opportunities'))
                .send({ name: `${token} one`, amount: { amountMinor: 1000 } })
                .expect(201);
            await as(admin)
                .post(w('/opportunities'))
                .send({ name: `${token} two`, amount: { amountMinor: 2500 } })
                .expect(201);
            const groups = (await as(admin).get(w('/opportunities/group-by?field=currency')).expect(200))
                .body as Group[];
            expect(groups).toEqual([{ value: 'USD', count: 2, sum: { amountMinor: 3500, field: 'amount' } }]);
        });
    });

    describe('CSV export', () => {
        it('streams the scoped rows with a BOM, labelled headers, chosen columns and no live formulas', async () => {
            const res = await as(admin)
                .get(w('/people/export.csv?columns=nameFirst,nameLast,custom.beat&sort=nameLast:asc'))
                .expect(200)
                .expect('Content-Type', /text\/csv/);
            const text = res.text;
            expect(text.startsWith('﻿')).toBe(true);
            const lines = text.slice(1).split('\r\n').filter(Boolean);
            expect(lines[0]).toBe('First name,Last name,Beat');
            expect(lines).toHaveLength(4);
            expect(lines.find((l) => l.includes('Fintech'))).toBe(`${token},Fintech,fintech`);
            // The hostile first name is quoted (it holds quotes) and neutralised (it starts with `=`).
            expect(lines.find((l) => l.includes('Noscore'))).toBe(`"'=HYPERLINK(""x"")",Noscore,`);
        });

        it('an own-scoped member exports only their rows; another workspace exports none of ours', async () => {
            const rep1 = await as(rep).get(w('/people/export.csv?columns=nameLast')).expect(200);
            expect(rep1.text.slice(1).split('\r\n').filter(Boolean)).toEqual(['Last name', 'Health']);
            const elsewhere = await as(other)
                .get(`/api/w/${otherWorkspace}/people/export.csv?columns=nameLast`)
                .expect(200);
            expect(elsewhere.text.slice(1).split('\r\n').filter(Boolean)).toEqual(['Last name']);
        });

        it('refuses an unknown column and a column named twice', async () => {
            await as(admin).get(w('/people/export.csv?columns=secret')).expect(400);
            await as(admin).get(w('/people/export.csv?columns=nameFirst,nameFirst')).expect(400);
        });
    });

    describe('global search', () => {
        it('finds across objects under the caller’s scope and never across workspaces', async () => {
            const all = (
                await as(admin)
                    .get(w(`/search?q=${token}`))
                    .expect(200)
            ).body as SearchResults;
            expect(all.person.map((h) => h.id).sort()).toEqual([adminsPerson, repsPerson].sort());
            expect(all.opportunity).toHaveLength(2);
            expect(all.company).toEqual([]);

            const mine = (
                await as(rep)
                    .get(w(`/search?q=${token}`))
                    .expect(200)
            ).body as SearchResults;
            expect(mine.person.map((h) => h.id)).toEqual([repsPerson]);

            const elsewhere = (await as(other).get(`/api/w/${otherWorkspace}/search?q=${token}`).expect(200))
                .body as SearchResults;
            expect(elsewhere).toEqual({ person: [], company: [], opportunity: [] });

            const only = (
                await as(admin)
                    .get(w(`/search?q=${token}&objects=opportunity&limit=1`))
                    .expect(200)
            ).body as SearchResults;
            expect(only.person).toEqual([]);
            expect(only.opportunity).toHaveLength(1);
        });
    });
});

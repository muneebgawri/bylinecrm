import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { BULK_MAX_IDS, CSRF_COOKIE, CSRF_HEADER, type FilterGroup, SESSION_COOKIE } from '@bylinecrm/shared';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { RlsPrismaService } from '../../src/infra/rls-prisma.service';
import { eventLog, settle } from '../support/outbox';

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

interface CountedPage<T> {
    items: T[];
    nextCursor: string | null;
    total: number;
    totalIsExact: boolean;
}
interface Summary {
    id: string;
    name: string;
}
interface Person {
    id: string;
    ownerId: string | null;
    companyId: string | null;
    company: Summary | null;
    owner: { memberId: string; name: string | null } | null;
}
interface Deal {
    id: string;
    company: Summary | null;
    pointOfContact: Summary | null;
    owner: { memberId: string; name: string | null } | null;
}
interface BulkResult {
    results: ({ id: string; ok: true; unchanged?: true } | { id: string; ok: false; error: string })[];
    succeeded: number;
    failed: number;
}
interface Activity {
    kind: string;
    properties: Record<string, unknown>;
}

const encode = (filter: FilterGroup) => Buffer.from(JSON.stringify(filter)).toString('base64url');
const byId = (ids: string[]): FilterGroup => ({ and: [{ field: 'id', op: 'in', value: ids }] });
const NOWHERE = '00000000-0000-4000-8000-00000000dead';

/**
 * P1-4a end to end: list totals, reading by id, related names on rows (without N+1), the export of
 * a selection, and bulk actions — each under the owner scope and the workspace boundary.
 */
describe('list totals, id-in, embedded names and bulk actions', () => {
    let app: INestApplication;
    let http: () => request.Agent;
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const password = 'correct horse battery staple';
    let admin: Browser;
    let rep: Browser;
    let other: Browser;
    let workspace: string;
    let otherWorkspace: string;
    let adminMemberId: string;
    let repMemberId: string;
    let acme: string;
    const adminPeople: string[] = [];
    let repsOwnPerson: string;
    let repsPersonAtAcme: string;
    let othersPerson: string;

    const as = (who: Browser) => ({
        get: (path: string) => http().get(path).set('Cookie', who.cookie),
        post: (path: string) => http().post(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
        patch: (path: string) => http().patch(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
    });
    const w = (path: string, ws = workspace) => `/api/w/${ws}${path}`;
    const page = <T>(res: Response) => res.body as CountedPage<T>;

    beforeAll(async () => {
        app = await createApp();
        await app.init();
        http = () => request(app.getHttpServer());

        const signup = await http()
            .post('/api/auth/signup')
            .send({ email: `admin-${stamp}@example.test`, password, workspaceName: 'Lists Co' })
            .expect(201);
        admin = browserFrom(signup);
        workspace = (signup.body as { workspace: { id: string } }).workspace.id;

        const otherSignup = await http()
            .post('/api/auth/signup')
            .send({ email: `other-${stamp}@example.test`, password, workspaceName: 'Elsewhere Co' })
            .expect(201);
        other = browserFrom(otherSignup);
        otherWorkspace = (otherSignup.body as { workspace: { id: string } }).workspace.id;

        // An own-scoped rep who may edit deals but not act on them in bulk.
        const role = await as(admin)
            .post(w('/roles'))
            .send({
                name: 'rep',
                capabilities: ['record:read', 'record:write', 'deal:read', 'deal:edit'],
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

        acme = ((await as(admin).post(w('/companies')).send({ name: 'Acme' }).expect(201)).body as { id: string }).id;
        for (const name of ['Ada', 'Bo', 'Cy']) {
            const res = await as(admin).post(w('/people')).send({ nameFirst: name, companyId: acme }).expect(201);
            adminPeople.push((res.body as Person).id);
        }
        repsOwnPerson = ((await as(rep).post(w('/people')).send({ nameFirst: 'Rae' }).expect(201)).body as Person).id;
        // The admin gives the rep a person whose company the rep cannot see.
        repsPersonAtAcme = (
            (
                await as(admin)
                    .post(w('/people'))
                    .send({ nameFirst: 'Rex', companyId: acme, ownerId: repMemberId })
                    .expect(201)
            ).body as Person
        ).id;
        othersPerson = (
            (await as(other).post(w('/people', otherWorkspace)).send({ nameFirst: 'Oz' }).expect(201)).body as Person
        ).id;
    });

    afterAll(async () => {
        await app.close();
    });

    describe('totals', () => {
        it('a page carries the total of the whole filtered, scoped set', async () => {
            const first = page<Person>(await as(admin).get(w('/people?limit=1')).expect(200));
            expect(first.items).toHaveLength(1);
            expect(first.nextCursor).not.toBeNull();
            expect(first).toMatchObject({ total: 5, totalIsExact: true });

            // The rep sees their own two, and the total says so — not the workspace's five.
            expect(page<Person>(await as(rep).get(w('/people')).expect(200))).toMatchObject({
                total: 2,
                totalIsExact: true,
            });

            const named = encode({ and: [{ field: 'nameFirst', op: 'in', value: ['Ada', 'Bo'] }] });
            expect(
                page(
                    await as(admin)
                        .get(w(`/people?filter=${named}&limit=1`))
                        .expect(200),
                ).total,
            ).toBe(2);
            expect(page(await as(admin).get(w('/people?q=Cy')).expect(200)).total).toBe(1);
            expect(page(await as(admin).post(w('/people/query')).send({ limit: 1 }).expect(200)).total).toBe(5);
            expect(page(await as(admin).get(w('/companies')).expect(200))).toMatchObject({ total: 1 });
        });
    });

    describe('reading by id', () => {
        it('returns the visible ones of the ids named — never another workspace’s, never an error', async () => {
            const ids = [...adminPeople, othersPerson, NOWHERE];
            const res = page<Person>(
                await as(admin)
                    .post(w('/people/query'))
                    .send({ filter: byId(ids) })
                    .expect(200),
            );
            expect(res.items.map((p) => p.id).sort()).toEqual([...adminPeople].sort());
            expect(res.total).toBe(3);

            // The rep naming the admin's people gets an empty page, as if they did not exist.
            const repView = page(
                await as(rep)
                    .post(w('/people/query'))
                    .send({ filter: byId(adminPeople) })
                    .expect(200),
            );
            expect(repView).toMatchObject({ items: [], total: 0 });
        });

        it(`answers more than ${BULK_MAX_IDS} ids with 413`, async () => {
            const ids = Array.from(
                { length: BULK_MAX_IDS + 1 },
                (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
            );
            await as(admin)
                .post(w('/people/query'))
                .send({ filter: byId(ids) })
                .expect(413);
        });

        it('exports a selection by id through the POST twin', async () => {
            const csv = await as(admin)
                .post(w('/people/export.csv'))
                .send({ filter: byId([adminPeople[0]!, othersPerson]), columns: 'id,nameFirst' })
                .expect(200);
            const lines = csv.text
                .replace(/^\u{FEFF}/u, '')
                .trim()
                .split(/\r?\n/);
            expect(lines).toEqual(['ID,First name', `${adminPeople[0]},Ada`]);
        });
    });

    describe('related names on rows', () => {
        it('a person carries its company and owner by name', async () => {
            const res = page<Person>(
                await as(admin)
                    .post(w('/people/query'))
                    .send({ filter: byId([adminPeople[0]!]) }),
            );
            expect(res.items[0]).toMatchObject({
                companyId: acme,
                company: { id: acme, name: 'Acme' },
                owner: { memberId: adminMemberId },
            });
        });

        it('a company the caller cannot see is null beside its id — the id is still there', async () => {
            const res = page<Person>(
                await as(rep)
                    .post(w('/people/query'))
                    .send({ filter: byId([repsPersonAtAcme]) }),
            );
            expect(res.items[0]).toMatchObject({ companyId: acme, company: null, owner: { memberId: repMemberId } });
        });

        it('a deal carries its company, point of contact and owner by name', async () => {
            const deal = (
                await as(admin)
                    .post(w('/opportunities'))
                    .send({ name: 'Series B PR', companyId: acme, pointOfContactId: adminPeople[0] })
                    .expect(201)
            ).body as Deal;
            expect(deal).toMatchObject({
                company: { id: acme, name: 'Acme' },
                pointOfContact: { id: adminPeople[0], name: 'Ada' },
                owner: { memberId: adminMemberId },
            });
            const listed = page<Deal>(await as(admin).get(w('/opportunities')).expect(200));
            expect(listed.items.find((d) => d.id === deal.id)).toMatchObject({ company: { name: 'Acme' } });
        });

        it('a page of fifty with their names costs the same statements as a page of ten — no N+1', async () => {
            // Fifty people, each at a company of their own.
            for (let i = 0; i < 50; i++) {
                const company = (
                    await as(admin)
                        .post(w('/companies'))
                        .send({ name: `N+1 Co ${i}` })
                        .expect(201)
                ).body as { id: string };
                await as(admin)
                    .post(w('/people'))
                    .send({ nameFirst: `Probe${i}`, companyId: company.id })
                    .expect(201);
            }
            const rls = app.get(RlsPrismaService);
            // Deliberately noisy background work: it reads `people` while the request under test
            // runs. Work that is not the request's must not count against the request.
            const noisy = async (): Promise<void> => {
                await rls.withWorkspace(workspace, (tx) => tx.person.findMany({ take: 5 }));
                await rls.withWorkspace(workspace, (tx) => tx.company.findMany({ take: 5 }));
            };
            const LIST_MODELS = new Set(['Person', 'Company', 'WorkspaceMember']);
            const statements = async (limit: number): Promise<number> => {
                let count = 0;
                const requestId = `nplus1-${limit}-${Math.random().toString(36).slice(2, 10)}`;
                // Only the request tagged with this id is observed; the noise runs in its own context.
                const stop = rls.observeQueries(
                    (query) => {
                        if (
                            (query.model && LIST_MODELS.has(query.model)) ||
                            /"?(people|companies|workspace_members)"?\b/.test(query.sql ?? '')
                        ) {
                            count += 1;
                        }
                    },
                    { requestId },
                );
                try {
                    const [res] = await Promise.all([
                        as(admin)
                            .get(w(`/people?limit=${limit}`))
                            .set('X-Request-Id', requestId)
                            .expect(200),
                        // Noise only in the larger request: if it were counted, fifty would exceed ten.
                        limit === 50 ? noisy() : Promise.resolve(),
                    ]);
                    const listed = page<Person>(res);
                    expect(listed.items).toHaveLength(limit);
                    expect(listed.items.every((p) => p.company !== null)).toBe(true);
                } finally {
                    stop();
                }
                return count;
            };
            const ten = await statements(10);
            const fifty = await statements(50);
            expect(ten).toBeGreaterThan(0);
            expect(fifty).toBe(ten);
        });
    });

    describe('bulk actions', () => {
        it('an id the caller cannot act on is not_found — the same answer for another workspace’s and for none', async () => {
            const res = (
                await as(admin)
                    .post(w('/people/bulk'))
                    .send({ action: 'delete', ids: [adminPeople[2]!, othersPerson, NOWHERE] })
                    .expect(200)
            ).body as BulkResult;
            expect(res.results).toEqual([
                { id: adminPeople[2], ok: true },
                { id: othersPerson, ok: false, error: 'not_found' },
                { id: NOWHERE, ok: false, error: 'not_found' },
            ]);
            expect(res).toMatchObject({ succeeded: 1, failed: 2 });
            // The other workspace's person is untouched.
            await as(other)
                .get(w(`/people/${othersPerson}`, otherWorkspace))
                .expect(200);
        });

        it('restores what it deleted, selected by a filter over the trash', async () => {
            const res = (
                await as(admin)
                    .post(w('/people/bulk'))
                    .send({ action: 'restore', filter: byId([adminPeople[2]!]) })
                    .expect(200)
            ).body as BulkResult;
            expect(res.results).toEqual([{ id: adminPeople[2], ok: true }]);
            await as(admin)
                .get(w(`/people/${adminPeople[2]}`))
                .expect(200);
        });

        it('one event per record changed: N single `person.updated` entries, each with the owner diff', async () => {
            const res = (
                await as(admin)
                    .post(w('/people/bulk'))
                    .send({ action: 'assign_owner', ids: adminPeople, ownerId: repMemberId })
                    .expect(200)
            ).body as BulkResult;
            expect(res.succeeded).toBe(adminPeople.length);
            await settle(app);
            for (const id of adminPeople) {
                const entries = await as(admin)
                    .get(w(`/timeline?target=person:${id}&kinds=person.updated`))
                    .then((r) => (r.body as { items: Activity[] }).items);
                expect(entries).toHaveLength(1);
                expect(entries[0]!.properties).toEqual({
                    diff: { ownerId: { from: adminMemberId, to: repMemberId } },
                });
            }
            // Give them back, so the later tests see the admin's people as the admin's.
            await as(admin)
                .post(w('/people/bulk'))
                .send({ action: 'assign_owner', ids: adminPeople, ownerId: adminMemberId })
                .expect(200);
        });

        it('an own-scoped rep may only assign to themselves, and only their own records change', async () => {
            await as(rep)
                .post(w('/people/bulk'))
                .send({ action: 'assign_owner', ids: [repsOwnPerson], ownerId: adminMemberId })
                .expect(403);
            const res = (
                await as(rep)
                    .post(w('/people/bulk'))
                    .send({ action: 'assign_owner', ids: [repsOwnPerson, adminPeople[0]!], ownerId: repMemberId })
                    .expect(200)
            ).body as BulkResult;
            // The rep's own person already is theirs: ok, unchanged — nothing written, nothing announced.
            expect(res.results).toEqual([
                { id: repsOwnPerson, ok: true, unchanged: true },
                { id: adminPeople[0], ok: false, error: 'not_found' },
            ]);
            const adminsAda = page<Person>(
                await as(admin)
                    .post(w('/people/query'))
                    .send({ filter: byId([adminPeople[0]!]) }),
            );
            expect(adminsAda.items[0]!.ownerId).toBe(adminMemberId);
        });

        it('a no-op writes and announces nothing — by PATCH or in bulk; a real change announces exactly once', async () => {
            const log = await eventLog(app, 'person.updated');
            const announced = async () => (await log.read()).map((event) => event.recordId);
            const target = adminPeople[1]!;
            const before = (
                await as(admin)
                    .get(w(`/people/${target}`))
                    .expect(200)
            ).body as { updatedAt: string };

            const patched = await as(admin)
                .patch(w(`/people/${target}`))
                .send({ ownerId: adminMemberId })
                .expect(200);
            expect((patched.body as { updatedAt: string }).updatedAt).toBe(before.updatedAt);

            const same = (
                await as(admin)
                    .post(w('/people/bulk'))
                    .send({ action: 'assign_owner', ids: [target], ownerId: adminMemberId })
                    .expect(200)
            ).body as BulkResult;
            expect(same.results).toEqual([{ id: target, ok: true, unchanged: true }]);
            expect(await announced()).toEqual([]);

            const moved = (
                await as(admin)
                    .post(w('/people/bulk'))
                    .send({ action: 'assign_owner', ids: [target], ownerId: repMemberId })
                    .expect(200)
            ).body as BulkResult;
            expect(moved.results).toEqual([{ id: target, ok: true }]);
            expect(await announced()).toEqual([target]);
            await as(admin)
                .post(w('/people/bulk'))
                .send({ action: 'assign_owner', ids: [adminPeople[1]!], ownerId: adminMemberId })
                .expect(200);
        });

        it('deals in bulk need deal:bulk and deal:edit; the request shape is checked', async () => {
            await as(rep)
                .post(w('/opportunities/bulk'))
                .send({ action: 'delete', ids: [NOWHERE] })
                .expect(403);
            // ids and a filter together, or ownerId without assign_owner: 400.
            await as(admin)
                .post(w('/people/bulk'))
                .send({ action: 'delete', ids: [NOWHERE], filter: byId([NOWHERE]) })
                .expect(400);
            await as(admin)
                .post(w('/people/bulk'))
                .send({ action: 'delete', ids: [NOWHERE], ownerId: null })
                .expect(400);
            const tooMany = Array.from(
                { length: BULK_MAX_IDS + 1 },
                (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
            );
            await as(admin).post(w('/people/bulk')).send({ action: 'delete', ids: tooMany }).expect(413);
        });
    });
});

import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE, SYSTEM_ROLES, type DomainEvent } from '@bylinecrm/shared';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RlsPrismaService } from '../../src/infra/rls-prisma.service';
import { WorkspaceContext } from '../../src/infra/workspace-context';
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

interface Person {
    id: string;
    nameFirst: string;
    emails: { primary: string | null; additional: string[] };
    ownerId: string | null;
    custom: Record<string, unknown>;
    createdBy: { kind: string; id: string | null };
    deletedAt: string | null;
}
interface Company {
    id: string;
    name: string;
    domain: string | null;
    arr: { amountMinor: number; currency: string } | null;
    ownerId: string | null;
    createdBy: { kind: string; id: string | null };
}
interface Page<T> {
    items: T[];
    nextCursor: string | null;
}

/**
 * Records end to end against the real application: the owner-scope rule applied by the route
 * and proven at the policy, uniqueness with deleted rows counted, custom-field validation,
 * trash and restore, search, pagination, events after commit, and the two actors.
 */
describe('records', () => {
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
    const events: DomainEvent[] = [];

    const as = (who: Browser) => ({
        get: (path: string) => http().get(path).set('Cookie', who.cookie),
        post: (path: string) => http().post(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
        patch: (path: string) => http().patch(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
        delete: (path: string) => http().delete(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
    });
    const w = (path: string) => `/api/w/${workspace}${path}`;

    beforeAll(async () => {
        app = await createApp();
        await app.init();
        http = () => request(app.getHttpServer());
        app.get(EventEmitter2).on('person.*', (event: DomainEvent) => events.push(event));
        app.get(EventEmitter2).on('company.*', (event: DomainEvent) => events.push(event));

        const signup = await http()
            .post('/api/auth/signup')
            .send({ email: `admin-${stamp}@example.test`, password, workspaceName: 'Records Co' })
            .expect(201);
        admin = browserFrom(signup);
        workspace = (signup.body as { workspace: { id: string } }).workspace.id;

        const otherSignup = await http()
            .post('/api/auth/signup')
            .send({ email: `other-${stamp}@example.test`, password, workspaceName: 'Elsewhere Co' })
            .expect(201);
        other = browserFrom(otherSignup);
        otherWorkspace = (otherSignup.body as { workspace: { id: string } }).workspace.id;

        // A "rep" role: reads and writes records, but only its own.
        const role = await as(admin)
            .post(w('/roles'))
            .send({ name: 'rep', capabilities: ['record:read', 'record:write'], recordScope: 'own' })
            .expect(201);
        const invite = await as(admin)
            .post(w('/invites'))
            .send({ email: `rep-${stamp}@example.test`, roleId: (role.body as { id: string }).id })
            .expect(201);
        const joined = await http()
            .post(`/api/auth/invites/${(invite.body as { token: string }).token}/signup`)
            .send({ password })
            .expect(201);
        rep = browserFrom(joined);

        const members = await as(admin).get(w('/members')).expect(200);
        const byEmail = new Map((members.body as { id: string; email: string }[]).map((m) => [m.email, m.id] as const));
        adminMemberId = byEmail.get(`admin-${stamp}@example.test`)!;
        repMemberId = byEmail.get(`rep-${stamp}@example.test`)!;
    });

    afterAll(async () => {
        await app.close();
    });

    describe('owner scope', () => {
        let adminsPerson: string;
        let repsPerson: string;

        it('an own-scoped member owns what they create, and may not name anyone else', async () => {
            const created = await as(rep)
                .post(w('/people'))
                .send({
                    nameFirst: 'Rep',
                    nameLast: 'Own',
                    emails: { primary: `rep-own-${stamp}@x.test`, additional: [] },
                })
                .expect(201);
            const person = created.body as Person;
            expect(person.ownerId).toBe(repMemberId);
            expect(person.createdBy).toEqual({ kind: 'member', id: repMemberId });
            repsPerson = person.id;

            await as(rep).post(w('/people')).send({ nameFirst: 'Nope', ownerId: adminMemberId }).expect(403);
        });

        it('an admin sees every record; the member sees only their own', async () => {
            const created = await as(admin)
                .post(w('/people'))
                .send({
                    nameFirst: 'Admin',
                    nameLast: 'Owned',
                    emails: { primary: `admin-own-${stamp}@x.test`, additional: [] },
                })
                .expect(201);
            adminsPerson = (created.body as Person).id;
            expect((created.body as Person).ownerId).toBe(adminMemberId);

            const adminList = await as(admin).get(w('/people')).expect(200);
            const adminIds = (adminList.body as Page<Person>).items.map((p) => p.id);
            expect(adminIds).toEqual(expect.arrayContaining([adminsPerson, repsPerson]));

            const repList = await as(rep).get(w('/people')).expect(200);
            expect((repList.body as Page<Person>).items.map((p) => p.id)).toEqual([repsPerson]);
        });

        it("another owner's record answers 404, not 403, to every verb", async () => {
            await as(rep)
                .get(w(`/people/${adminsPerson}`))
                .expect(404);
            await as(rep)
                .patch(w(`/people/${adminsPerson}`))
                .send({ city: 'Lahore' })
                .expect(404);
            await as(rep)
                .delete(w(`/people/${adminsPerson}`))
                .expect(404);
            await as(rep)
                .post(w(`/people/${adminsPerson}/restore`))
                .expect(404);
        });

        it('the restrictive policy holds even when the application forgets the filter', async () => {
            const rls = app.get(RlsPrismaService);
            const context = app.get(WorkspaceContext);
            const seen = await context.run(
                {
                    workspaceId: workspace,
                    memberId: repMemberId,
                    ownerScopeMemberId: repMemberId,
                    capabilities: new Set(),
                },
                () => rls.withWorkspace((tx) => tx.person.findMany({ select: { id: true } })),
            );
            expect(seen.map((p) => p.id)).toEqual([repsPerson]);

            await expect(
                context.run(
                    {
                        workspaceId: workspace,
                        memberId: repMemberId,
                        ownerScopeMemberId: repMemberId,
                        capabilities: new Set(),
                    },
                    () =>
                        rls.withWorkspace((tx) =>
                            tx.person.create({
                                data: {
                                    workspaceId: workspace,
                                    nameFirst: 'Smuggled',
                                    ownerId: adminMemberId,
                                    createdBy: { kind: 'system', id: null },
                                },
                            }),
                        ),
                ),
            ).rejects.toThrow(/row-level security/);
        });

        it('a key acting with an own-scoped role is refused at the gate', async () => {
            const roles = await as(admin).get(w('/roles')).expect(200);
            const repRole = (roles.body as { id: string; name: string }[]).find((r) => r.name === 'rep')!;
            const key = await as(admin).post(w('/api-keys')).send({ name: 'rep key', roleId: repRole.id }).expect(201);
            const { secret } = key.body as { secret: string };
            await http().get(w('/people')).set('Authorization', `Bearer ${secret}`).expect(403);
        });

        it('a key with a full-scope role creates records as itself, with no owner', async () => {
            const roles = await as(admin).get(w('/roles')).expect(200);
            const adminRole = (roles.body as { id: string; name: string }[]).find(
                (r) => r.name === SYSTEM_ROLES.admin,
            )!;
            const key = await as(admin).post(w('/api-keys')).send({ name: 'import', roleId: adminRole.id }).expect(201);
            const { key: view, secret } = key.body as { key: { id: string }; secret: string };
            const created = await http()
                .post(w('/companies'))
                .set('Authorization', `Bearer ${secret}`)
                .send({ name: 'Imported Ltd' })
                .expect(201);
            expect((created.body as Company).ownerId).toBeNull();
            expect((created.body as Company).createdBy).toEqual({ kind: 'api_key', id: view.id });
        });

        it("tells each caller their own standing, and never another workspace's", async () => {
            const mine = await as(rep).get(w('/me')).expect(200);
            expect(mine.body).toMatchObject({
                workspaceId: workspace,
                memberId: repMemberId,
                roleName: 'rep',
                recordScope: 'own',
                capabilities: ['record:read', 'record:write'],
            });
            const theirs = await as(other).get(`/api/w/${otherWorkspace}/me`).expect(200);
            expect((theirs.body as { capabilities: string[] }).capabilities).toContain('workspace:admin');
            await as(other).get(w('/me')).expect(403);
        });

        it('another workspace sees nothing of this one', async () => {
            await as(other).get(`/api/w/${otherWorkspace}/people/${adminsPerson}`).expect(404);
            const list = await as(other).get(`/api/w/${otherWorkspace}/people`).expect(200);
            expect((list.body as Page<Person>).items).toEqual([]);
        });
    });

    describe('uniqueness', () => {
        it('refuses a second primary email, case-insensitively, and a second domain', async () => {
            await as(admin)
                .post(w('/people'))
                .send({ nameFirst: 'Dana', emails: { primary: `Dana-${stamp}@Acme.test`, additional: [] } })
                .expect(201);
            const dup = await as(admin)
                .post(w('/people'))
                .send({ nameFirst: 'Dana', emails: { primary: `dana-${stamp}@acme.test`, additional: [] } })
                .expect(409);
            expect(dup.body).toMatchObject({ code: 'conflict.unique', fieldErrors: [{ path: 'emails.primary' }] });

            await as(admin)
                .post(w('/companies'))
                .send({ name: 'Acme', domain: `Acme-${stamp}.test` })
                .expect(201);
            await as(admin)
                .post(w('/companies'))
                .send({ name: 'Acme 2', domain: `acme-${stamp}.test` })
                .expect(409);
        });

        it('a deleted record still holds its email', async () => {
            const created = await as(admin)
                .post(w('/people'))
                .send({ nameFirst: 'Gone', emails: { primary: `gone-${stamp}@x.test`, additional: [] } })
                .expect(201);
            await as(admin)
                .delete(w(`/people/${(created.body as Person).id}`))
                .expect(204);
            await as(admin)
                .post(w('/people'))
                .send({ nameFirst: 'Again', emails: { primary: `gone-${stamp}@x.test`, additional: [] } })
                .expect(409);
        });

        it('a person needs a name or a primary email', async () => {
            await as(admin).post(w('/people')).send({ city: 'Nowhere' }).expect(422);
        });
    });

    describe('custom fields', () => {
        let beatId: string;

        it('an admin defines fields; a member may read them', async () => {
            const beat = await as(admin)
                .post(w('/custom-fields'))
                .send({
                    object: 'person',
                    key: 'beat',
                    label: 'Beat',
                    type: 'select',
                    options: ['fintech', 'health'],
                    required: true,
                })
                .expect(201);
            beatId = (beat.body as { id: string }).id;
            await as(admin)
                .post(w('/custom-fields'))
                .send({ object: 'person', key: 'score', label: 'Score', type: 'number' })
                .expect(201);
            await as(admin)
                .post(w('/custom-fields'))
                .send({ object: 'person', key: 'beat', label: 'Dup', type: 'text' })
                .expect(409);
            await as(admin)
                .post(w('/custom-fields'))
                .send({ object: 'person', key: 'nope', label: 'No options', type: 'select' })
                .expect(400);
            await as(rep)
                .post(w('/custom-fields'))
                .send({ object: 'person', key: 'x', label: 'x', type: 'text' })
                .expect(403);
            const listed = await as(rep).get(w('/custom-fields?object=person')).expect(200);
            expect((listed.body as { key: string }[]).map((f) => f.key).sort()).toEqual(['beat', 'score']);
        });

        it('values are validated against the definitions, with paths under custom.', async () => {
            const missing = await as(admin).post(w('/people')).send({ nameFirst: 'No Beat' }).expect(400);
            expect(JSON.stringify(missing.body)).toContain('custom.beat');
            const wrong = await as(admin)
                .post(w('/people'))
                .send({ nameFirst: 'Wrong', custom: { beat: 'sports', score: 'high', colour: 'red' } })
                .expect(400);
            expect(JSON.stringify(wrong.body)).toContain('custom.colour');
            expect(JSON.stringify(wrong.body)).toContain('custom.score');
            const ok = await as(admin)
                .post(w('/people'))
                .send({ nameFirst: 'Right', custom: { beat: 'fintech', score: 7 } })
                .expect(201);
            expect((ok.body as Person).custom).toEqual({ beat: 'fintech', score: 7 });

            const patched = await as(admin)
                .patch(w(`/people/${(ok.body as Person).id}`))
                .send({ custom: { score: null } })
                .expect(200);
            expect((patched.body as Person).custom).toEqual({ beat: 'fintech' });
            await as(admin)
                .patch(w(`/people/${(ok.body as Person).id}`))
                .send({ custom: { beat: null } })
                .expect(400);
        });

        it('an archived field is unknown from then on; stored values stay', async () => {
            await as(admin)
                .delete(w(`/custom-fields/${beatId}`))
                .expect(204);
            await as(admin)
                .post(w('/people'))
                .send({ nameFirst: 'Free', custom: { beat: 'fintech' } })
                .expect(400);
            const created = await as(admin).post(w('/people')).send({ nameFirst: 'Free' }).expect(201);
            expect((created.body as Person).custom).toEqual({});
            const listed = await as(admin).get(w('/custom-fields?object=person&archived=true')).expect(200);
            expect((listed.body as { key: string }[]).map((f) => f.key)).toEqual(['beat']);
        });
    });

    describe('trash, search, pagination, events', () => {
        it('deletes softly, lists the trash, restores', async () => {
            const created = await as(admin)
                .post(w('/companies'))
                .send({ name: `Trashable ${stamp}`, arr: { amountMinor: 120050 } })
                .expect(201);
            const id = (created.body as Company).id;
            expect((created.body as Company).arr).toEqual({ amountMinor: 120050, currency: 'USD' });
            await as(admin)
                .delete(w(`/companies/${id}`))
                .expect(204);
            await as(admin)
                .get(w(`/companies/${id}`))
                .expect(404);
            const trash = await as(admin).get(w('/companies/deleted')).expect(200);
            expect((trash.body as Page<Company>).items.map((c) => c.id)).toContain(id);
            await as(rep).get(w('/companies/deleted')).expect(200);
            await as(admin)
                .post(w(`/companies/${id}/restore`))
                .expect(201);
            await as(admin)
                .get(w(`/companies/${id}`))
                .expect(200);
        });

        it('finds people by name and by email prefix, companies by domain', async () => {
            await as(admin)
                .post(w('/people'))
                .send({
                    nameFirst: 'Zelda',
                    nameLast: 'Quartermain',
                    emails: { primary: `zq-${stamp}@hyrule.test`, additional: [] },
                })
                .expect(201);
            const byName = await as(admin).get(w('/people?q=quartermain')).expect(200);
            expect((byName.body as Page<Person>).items.map((p) => p.nameFirst)).toEqual(['Zelda']);
            const byEmail = await as(admin)
                .get(w(`/people?q=zq-${stamp}`))
                .expect(200);
            expect((byEmail.body as Page<Person>).items.map((p) => p.nameFirst)).toEqual(['Zelda']);
            const none = await as(admin).get(w('/people?q=nobodyatall')).expect(200);
            expect((none.body as Page<Person>).items).toEqual([]);

            await as(admin)
                .post(w('/companies'))
                .send({ name: 'Hyrule Castle', domain: `hyrule-${stamp}.test` })
                .expect(201);
            const byDomain = await as(admin)
                .get(w(`/companies?q=hyrule-${stamp}`))
                .expect(200);
            expect((byDomain.body as Page<Company>).items.map((c) => c.name)).toEqual(['Hyrule Castle']);
        });

        it('pages with a cursor under a chosen sort, and refuses a sort off the allowlist', async () => {
            for (const name of ['Page A', 'Page B', 'Page C']) {
                await as(admin)
                    .post(w('/companies'))
                    .send({ name: `${name} ${stamp}` })
                    .expect(201);
            }
            const first = await as(admin).get(w(`/companies?limit=2&sort=name:asc&q=Page`)).expect(200);
            const page1 = first.body as Page<Company>;
            expect(page1.items.map((c) => c.name)).toEqual([`Page A ${stamp}`, `Page B ${stamp}`]);
            expect(page1.nextCursor).not.toBeNull();
            const second = await as(admin)
                .get(w(`/companies?limit=2&sort=name:asc&q=Page&cursor=${page1.nextCursor}`))
                .expect(200);
            const page2 = second.body as Page<Company>;
            expect(page2.items.map((c) => c.name)).toEqual([`Page C ${stamp}`]);
            expect(page2.nextCursor).toBeNull();

            await as(admin).get(w('/companies?sort=secret:asc')).expect(400);
            await as(admin).get(w('/companies?cursor=garbage')).expect(400);
            await as(admin).get(w('/companies?limit=500')).expect(400);
        });

        it('publishes an event after each commit, with the actor and a diff on update', async () => {
            events.length = 0;
            const created = await as(admin).post(w('/people')).send({ nameFirst: 'Eve', nameLast: 'Nt' }).expect(201);
            const id = (created.body as Person).id;
            await as(admin)
                .patch(w(`/people/${id}`))
                .send({ nameLast: 'Nted' })
                .expect(200);
            await as(admin)
                .delete(w(`/people/${id}`))
                .expect(204);
            await as(admin)
                .post(w(`/people/${id}/restore`))
                .expect(201);
            expect(events.map((e) => e.type)).toEqual([
                'person.created',
                'person.updated',
                'person.deleted',
                'person.restored',
            ]);
            expect(events[0]).toMatchObject({
                object: 'person',
                workspaceId: workspace,
                recordId: id,
                actor: { kind: 'member', id: adminMemberId },
            });
            expect(events[1]?.diff).toEqual({ nameLast: { from: 'Nt', to: 'Nted' } });

            events.length = 0;
            await as(admin)
                .post(w('/people'))
                .send({ nameFirst: 'Rolled', ownerId: '00000000-0000-4000-8000-000000000000' })
                .expect(422);
            expect(events).toEqual([]);
        });
    });
});

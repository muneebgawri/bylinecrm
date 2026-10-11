import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE } from '@bylinecrm/shared';
import request, { type Response } from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app';
import { RlsPrismaService } from '../../src/infra/rls-prisma.service';
import { TimelineService } from '../../src/timeline/timeline.service';
import { settle } from '../support/outbox';

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

interface Activity {
    id: string;
    target: { type: string; id: string };
    kind: string;
    happenedAt: string;
    actor: { kind: string; id: string | null };
    properties: Record<string, unknown>;
    linked: { type: string; id: string } | null;
}
interface Page<T> {
    items: T[];
    nextCursor: string | null;
}

/**
 * The timeline end to end: a record's own events and the notes on it become entries, one per
 * target; a company's timeline merges its people's; entries follow the records' visibility
 * (another workspace, another owner's record: nothing); an integration's report is idempotent
 * per workspace; and the app role can append but never rewrite history.
 */
describe('timeline', () => {
    let app: INestApplication;
    let http: () => request.Agent;
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const password = 'correct horse battery staple';
    let admin: Browser;
    let rep: Browser;
    let other: Browser;
    let workspace: string;
    let otherWorkspace: string;
    let company: string;
    let adminsPerson: string;
    let repsPerson: string;

    const as = (who: Browser) => ({
        get: (path: string) => http().get(path).set('Cookie', who.cookie),
        post: (path: string) => http().post(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
        patch: (path: string) => http().patch(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
        delete: (path: string) => http().delete(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
    });
    const w = (path: string) => `/api/w/${workspace}${path}`;
    const timeline = (who: Browser, target: string, extra = '') =>
        as(who)
            .get(w(`/timeline?target=${target}${extra}`))
            .then((res) => res.body as Page<Activity>);
    const kinds = (page: Page<Activity>) => page.items.map((a) => a.kind);

    beforeAll(async () => {
        app = await createApp();
        await app.init();
        http = () => request(app.getHttpServer());

        const signup = await http()
            .post('/api/auth/signup')
            .send({ email: `admin-${stamp}@example.test`, password, workspaceName: 'Timeline Co' })
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
                capabilities: ['record:read', 'record:write', 'note:write', 'task:write'],
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

        company = ((await as(admin).post(w('/companies')).send({ name: 'Acme' }).expect(201)).body as { id: string })
            .id;
        adminsPerson = (
            (
                await as(admin)
                    .post(w('/people'))
                    .send({ nameFirst: 'Dana', nameLast: 'Reyes', companyId: company })
                    .expect(201)
            ).body as { id: string }
        ).id;
        repsPerson = (
            (await as(rep).post(w('/people')).send({ nameFirst: 'Rep', nameLast: 'Owned' }).expect(201)).body as {
                id: string;
            }
        ).id;
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    afterAll(async () => {
        await app.close();
    });

    it('P0-13 (#89): an entry written after the request answered is on the timeline once events are settled', async () => {
        // Hold the timeline consumer until the request has answered: the race the old reads lost
        // (they read before the subscriber wrote, and passed or failed by timing).
        const service = app.get(TimelineService);
        const writeFor = service.writeFor.bind(service);
        let release!: () => void;
        const held = new Promise<void>((resolve) => (release = resolve));
        vi.spyOn(service, 'writeFor').mockImplementation(async (delivered) => {
            await held;
            return writeFor(delivered);
        });
        const heldPerson = (
            (await as(admin).post(w('/people')).send({ nameFirst: 'Held', nameLast: 'Back' }).expect(201)).body as {
                id: string;
            }
        ).id;
        await as(admin)
            .patch(w(`/people/${heldPerson}`))
            .send({ jobTitle: 'Held' })
            .expect(200);
        expect(kinds(await timeline(admin, `person:${heldPerson}`))).toEqual([]);

        const settled = settle(app);
        release();
        await settled;
        const page = await timeline(admin, `person:${heldPerson}`);
        expect(kinds(page)).toEqual(['person.updated', 'person.created']);
        expect(page.items[0]!.properties).toMatchObject({ diff: { jobTitle: { to: 'Held' } } });
    });

    it('turns a record’s own events into entries, carrying the diff the event carried', async () => {
        await as(admin)
            .patch(w(`/people/${adminsPerson}`))
            .send({ nameFirst: 'Dan' })
            .expect(200);
        await settle(app);
        const page = await timeline(admin, `person:${adminsPerson}`);
        expect(kinds(page)).toEqual(['person.updated', 'person.created']);
        const updated = page.items[0]!;
        expect(updated.target).toEqual({ type: 'person', id: adminsPerson });
        expect(updated.properties).toEqual({ diff: { nameFirst: { from: 'Dana', to: 'Dan' } } });
        expect(updated.actor.kind).toBe('member');
        expect(updated.linked).toBeNull();
    });

    it('writes a note on each record it is on, naming the note, and filters by kind prefix', async () => {
        const note = await as(admin)
            .post(w('/notes'))
            .send({
                title: 'FinCon',
                targets: [
                    { type: 'person', id: adminsPerson },
                    { type: 'company', id: company },
                ],
            })
            .expect(201);
        const noteId = (note.body as { id: string }).id;
        await settle(app);
        const onPerson = await timeline(admin, `person:${adminsPerson}`, '&kinds=linked-note');
        expect(kinds(onPerson)).toEqual(['linked-note.created']);
        expect(onPerson.items[0]!.linked).toEqual({ type: 'note', id: noteId });
        expect(onPerson.items[0]!.properties).toEqual({ linked: { type: 'note', id: noteId, name: 'FinCon' } });
        const onCompany = await timeline(admin, `company:${company}`, '&kinds=linked-note');
        expect(onCompany.items.filter((a) => a.target.id === company).map((a) => a.kind)).toEqual([
            'linked-note.created',
        ]);
    });

    it('merges a company’s people into its timeline, each entry tagged with its own record', async () => {
        const page = await timeline(admin, `company:${company}`);
        const targets = new Set(page.items.map((a) => `${a.target.type}:${a.target.id}`));
        expect(targets).toEqual(new Set([`company:${company}`, `person:${adminsPerson}`]));
        expect(kinds(page)).toContain('company.created');
        expect(kinds(page)).toContain('person.updated');
        const own = await timeline(admin, `person:${adminsPerson}`);
        expect(own.items.every((a) => a.target.id === adminsPerson)).toBe(true);
    });

    it('pages newest first with a cursor, within the limit', async () => {
        const first = await timeline(admin, `company:${company}`, '&limit=2');
        expect(first.items).toHaveLength(2);
        expect(first.nextCursor).not.toBeNull();
        const second = await timeline(admin, `company:${company}`, `&limit=2&cursor=${first.nextCursor}`);
        expect(second.items.map((a) => a.id)).not.toContain(first.items[0]!.id);
        const stamps = [...first.items, ...second.items].map((a) => a.happenedAt);
        expect([...stamps].sort().reverse()).toEqual(stamps);
        await as(admin)
            .get(w(`/timeline?target=company:${company}&limit=101`))
            .expect(400);
    });

    it('shows nothing for a record the caller cannot see: another owner’s, or another workspace’s', async () => {
        await as(rep)
            .get(w(`/timeline?target=person:${adminsPerson}`))
            .expect(404);
        await as(other).get(`/api/w/${otherWorkspace}/timeline?target=person:${adminsPerson}`).expect(404);
        await settle(app);
        const own = await timeline(rep, `person:${repsPerson}`);
        expect(kinds(own)).toEqual(['person.created']);
    });

    it('records an integration’s report once per key, generic and workspace-scoped', async () => {
        const body = {
            target: `company:${company}`,
            kind: 'external.order_paid',
            happenedAt: '2026-10-01T12:00:00Z',
            title: 'Order paid',
            url: 'https://example.test/orders/42',
            amount: { amountMinor: 120000, currency: 'USD' },
            source: 'newswire',
            idempotencyKey: 'order-42',
        };
        const first = await as(admin).post(w('/timeline/external')).send(body).expect(201);
        const second = await as(admin).post(w('/timeline/external')).send(body).expect(201);
        const a = first.body as { activity: Activity; created: boolean };
        const b = second.body as { activity: Activity; created: boolean };
        expect(a.created).toBe(true);
        expect(b.created).toBe(false);
        expect(b.activity.id).toBe(a.activity.id);
        expect(a.activity.kind).toBe('external.order_paid');
        expect(a.activity.actor).toEqual({ kind: 'external', id: 'newswire' });
        expect(a.activity.properties).toMatchObject({ title: 'Order paid', amount: body.amount });

        // The same key in another workspace is another entry; a target it cannot see is refused.
        const otherCompany = (
            (await as(other).post(`/api/w/${otherWorkspace}/companies`).send({ name: 'Elsewhere' }).expect(201))
                .body as { id: string }
        ).id;
        const elsewhere = await as(other)
            .post(`/api/w/${otherWorkspace}/timeline/external`)
            .send({ ...body, target: `company:${otherCompany}` })
            .expect(201);
        expect((elsewhere.body as { created: boolean }).created).toBe(true);
        await as(other)
            .post(`/api/w/${otherWorkspace}/timeline/external`)
            .send({ ...body, idempotencyKey: 'order-43' })
            .expect(422);
        await as(admin)
            .post(w('/timeline/external'))
            .send({ ...body, kind: 'order_paid' })
            .expect(400);
    });

    it('lets the app role append to history and never rewrite it', async () => {
        const rls = app.get(RlsPrismaService);
        await expect(
            rls.withWorkspace(workspace, (tx) =>
                tx.timelineActivity.updateMany({ data: { kind: 'person.rewritten' } }),
            ),
        ).rejects.toThrow(/permission denied/);
        await expect(rls.withWorkspace(workspace, (tx) => tx.timelineActivity.deleteMany({}))).rejects.toThrow(
            /permission denied/,
        );
        const unchanged = await timeline(admin, `person:${adminsPerson}`);
        expect(kinds(unchanged)).not.toContain('person.rewritten');
    });
});

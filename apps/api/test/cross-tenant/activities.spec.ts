import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE } from '@bylinecrm/shared';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { eventLog, type EventLog } from '../support/outbox';
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

interface Opportunity {
    id: string;
    name: string;
    amount: { amountMinor: number; currency: string } | null;
    currency: string;
    closeDate: string | null;
    ownerId: string | null;
    companyId: string | null;
    pointOfContactId: string | null;
}
interface Note {
    id: string;
    title: string;
    bodyText: string;
    targets: { type: string; id: string }[];
    authorId: string | null;
}
interface Task {
    id: string;
    status: string;
    completedAt: string | null;
    assigneeId: string | null;
    targets: { type: string; id: string }[];
}
interface Attachment {
    id: string;
    name: string;
    mime: string;
    sizeBytes: number;
    target: { type: string; id: string };
}
interface Page<T> {
    items: T[];
    nextCursor: string | null;
}

/**
 * Deals, notes, tasks and attachments end to end: targets cannot cross workspaces or the caller's
 * owner scope, a thing is visible through the records it is on, `completedAt` follows the one
 * rule, attachment bytes are reachable only through a row the caller can see, and events carry
 * their targets.
 */
describe('deals, notes, tasks, attachments', () => {
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
    let adminsPerson: string;
    let repsPerson: string;
    let adminsCompany: string;
    let repsCompany: string;
    let otherPerson: string;
    let events: EventLog;

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
        events = await eventLog(app, 'opportunity.*', 'note.*', 'task.*', 'attachment.*');

        const signup = await http()
            .post('/api/auth/signup')
            .send({ email: `admin-${stamp}@example.test`, password, workspaceName: 'Deals Co' })
            .expect(201);
        await verifyAddress(app, http, `admin-${stamp}@example.test`);
        admin = browserFrom(signup);
        workspace = (signup.body as { workspace: { id: string } }).workspace.id;

        const otherSignup = await http()
            .post('/api/auth/signup')
            .send({ email: `other-${stamp}@example.test`, password, workspaceName: 'Elsewhere Co' })
            .expect(201);
        await verifyAddress(app, http, `other-${stamp}@example.test`);
        other = browserFrom(otherSignup);
        otherWorkspace = (otherSignup.body as { workspace: { id: string } }).workspace.id;

        const role = await as(admin)
            .post(w('/roles'))
            .send({
                name: 'rep',
                capabilities: ['record:read', 'record:write', 'note:write', 'task:write', 'deal:read', 'deal:edit'],
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
        await verifyAddress(app, http, `rep-${stamp}@example.test`);

        const members = await as(admin).get(w('/members')).expect(200);
        const byEmail = new Map((members.body as { id: string; email: string }[]).map((m) => [m.email, m.id] as const));
        adminMemberId = byEmail.get(`admin-${stamp}@example.test`)!;
        repMemberId = byEmail.get(`rep-${stamp}@example.test`)!;

        adminsPerson = (
            (await as(admin).post(w('/people')).send({ nameFirst: 'Admin', nameLast: 'Owned' }).expect(201)).body as {
                id: string;
            }
        ).id;
        repsPerson = (
            (await as(rep).post(w('/people')).send({ nameFirst: 'Rep', nameLast: 'Owned' }).expect(201)).body as {
                id: string;
            }
        ).id;
        adminsCompany = (
            (
                await as(admin)
                    .post(w('/companies'))
                    .send({ name: `Admin Co ${stamp}` })
                    .expect(201)
            ).body as { id: string }
        ).id;
        repsCompany = (
            (
                await as(rep)
                    .post(w('/companies'))
                    .send({ name: `Rep Co ${stamp}` })
                    .expect(201)
            ).body as { id: string }
        ).id;
        otherPerson = (
            (
                await as(other)
                    .post(`/api/w/${otherWorkspace}/people`)
                    .send({ nameFirst: 'Else', nameLast: 'Where' })
                    .expect(201)
            ).body as { id: string }
        ).id;
    });

    afterAll(async () => {
        await app.close();
    });

    describe('members summary', () => {
        it('names members for pickers without their emails, to anyone who reads records', async () => {
            const summary = await as(rep).get(w('/members/summary')).expect(200);
            const rows = summary.body as { memberId: string; name: string | null }[];
            expect(rows.map((r) => r.memberId).sort()).toEqual([adminMemberId, repMemberId].sort());
            expect(rows.find((r) => r.memberId === repMemberId)?.name).toBe(`rep-${stamp}`);
            expect(JSON.stringify(summary.body)).not.toContain('@example.test');
            await as(rep).get(w('/members')).expect(403);
        });
    });

    describe('opportunities', () => {
        let deal: string;

        it('takes the workspace currency when none is named, and an exact minor amount', async () => {
            const created = await as(admin)
                .post(w('/opportunities'))
                .send({
                    name: 'Series B PR',
                    companyId: adminsCompany,
                    amount: { amountMinor: 1200000 },
                    closeDate: '2026-10-31',
                    probability: 60,
                })
                .expect(201);
            const body = created.body as Opportunity;
            deal = body.id;
            expect(body.amount).toEqual({ amountMinor: 1200000, currency: 'USD' });
            expect(body.currency).toBe('USD');
            expect(body.closeDate).toBe('2026-10-31');
            expect(body.ownerId).toBe(adminMemberId);
        });

        it('refuses a point of contact or company outside the caller’s scope, as 422', async () => {
            await as(rep)
                .post(w('/opportunities'))
                .send({ name: 'Nope', companyId: repsCompany, pointOfContactId: adminsPerson })
                .expect(422);
            await as(rep)
                .post(w('/opportunities'))
                .send({ name: 'Nope', companyId: repsCompany, pointOfContactId: otherPerson })
                .expect(422);
            const ok = await as(rep)
                .post(w('/opportunities'))
                .send({
                    name: 'Rep deal',
                    companyId: repsCompany,
                    pointOfContactId: repsPerson,
                    amount: { amountMinor: 50000, currency: 'EUR' },
                })
                .expect(201);
            expect((ok.body as Opportunity).amount).toEqual({ amountMinor: 50000, currency: 'EUR' });
        });

        it('is owner-scoped like a person: 404 across owners, invisible across workspaces', async () => {
            await as(rep)
                .get(w(`/opportunities/${deal}`))
                .expect(404);
            await as(other).get(`/api/w/${otherWorkspace}/opportunities/${deal}`).expect(404);
            const mine = await as(rep).get(w('/opportunities')).expect(200);
            expect((mine.body as Page<Opportunity>).items.map((o) => o.name)).toEqual(['Rep deal']);
            const found = await as(admin).get(w('/opportunities?q=series')).expect(200);
            expect((found.body as Page<Opportunity>).items.map((o) => o.id)).toEqual([deal]);
        });

        it('clears the amount with null and keeps the currency; the trash restores', async () => {
            const patched = await as(admin)
                .patch(w(`/opportunities/${deal}`))
                .send({ amount: null })
                .expect(200);
            expect((patched.body as Opportunity).amount).toBeNull();
            expect((patched.body as Opportunity).currency).toBe('USD');
            await as(admin)
                .delete(w(`/opportunities/${deal}`))
                .expect(204);
            await as(admin)
                .get(w(`/opportunities/${deal}`))
                .expect(404);
            await as(admin)
                .post(w(`/opportunities/${deal}/restore`))
                .expect(201);
            const types = (await events.read()).filter((e) => e.recordId === deal).map((e) => e.type);
            expect(types).toEqual([
                'opportunity.created',
                'opportunity.updated',
                'opportunity.deleted',
                'opportunity.restored',
            ]);
        });
    });

    describe('notes', () => {
        let note: string;

        it('attaches to several records, derives plain text, and is listed on each', async () => {
            const created = await as(admin)
                .post(w('/notes'))
                .send({
                    title: 'FinCon',
                    body: {
                        type: 'doc',
                        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Met at FinCon.' }] }],
                    },
                    targets: [
                        { type: 'person', id: adminsPerson },
                        { type: 'person', id: adminsPerson },
                        { type: 'person', id: repsPerson },
                    ],
                })
                .expect(201);
            const body = created.body as Note;
            note = body.id;
            expect(body.bodyText).toBe('Met at FinCon.');
            expect(body.targets).toHaveLength(2);
            expect(body.authorId).toBe(adminMemberId);
            const onReps = await as(admin)
                .get(w(`/notes?target=person:${repsPerson}`))
                .expect(200);
            expect((onReps.body as Page<Note>).items.map((n) => n.id)).toEqual([note]);
            const event = (await events.read()).find((e) => e.type === 'note.created' && e.recordId === note)!;
            expect(event.targets).toHaveLength(2);
        });

        it('is visible to whoever can see one of its targets, and only to them', async () => {
            // The rep owns one of the two targets: the note is theirs to read.
            await as(rep)
                .get(w(`/notes/${note}`))
                .expect(200);
            const adminOnly = await as(admin)
                .post(w('/notes'))
                .send({ title: 'Private to admin', targets: [{ type: 'person', id: adminsPerson }] })
                .expect(201);
            await as(rep)
                .get(w(`/notes/${(adminOnly.body as Note).id}`))
                .expect(404);
            await as(rep)
                .get(w(`/notes?target=person:${adminsPerson}`))
                .expect(404);
            await as(other).get(`/api/w/${otherWorkspace}/notes/${note}`).expect(404);
        });

        it('refuses a target the caller cannot see, or in another workspace, as 422', async () => {
            await as(rep)
                .post(w('/notes'))
                .send({ title: 'Nope', targets: [{ type: 'person', id: adminsPerson }] })
                .expect(422);
            await as(admin)
                .post(w('/notes'))
                .send({ title: 'Nope', targets: [{ type: 'person', id: otherPerson }] })
                .expect(422);
            await as(admin).post(w('/notes')).send({ title: 'Nope', targets: [] }).expect(400);
        });

        it('replaces its targets on patch, and the trash is reached through a target too', async () => {
            const patched = await as(admin)
                .patch(w(`/notes/${note}`))
                .send({ targets: [{ type: 'person', id: adminsPerson }] })
                .expect(200);
            expect((patched.body as Note).targets).toEqual([{ type: 'person', id: adminsPerson }]);
            await as(rep)
                .get(w(`/notes/${note}`))
                .expect(404);
            await as(admin)
                .delete(w(`/notes/${note}`))
                .expect(204);
            const trash = await as(admin)
                .get(w(`/notes/deleted?target=person:${adminsPerson}`))
                .expect(200);
            expect((trash.body as Page<Note>).items.map((n) => n.id)).toContain(note);
            await as(admin)
                .post(w(`/notes/${note}/restore`))
                .expect(201);
        });
    });

    describe('tasks', () => {
        let task: string;

        it('sets completedAt exactly when done, and clears it when it leaves done', async () => {
            const created = await as(admin)
                .post(w('/tasks'))
                .send({ title: 'Call Sam', targets: [{ type: 'person', id: adminsPerson }], assigneeId: repMemberId })
                .expect(201);
            task = (created.body as Task).id;
            expect((created.body as Task).completedAt).toBeNull();
            const done = await as(admin)
                .patch(w(`/tasks/${task}`))
                .send({ status: 'done' })
                .expect(200);
            const completedAt = (done.body as Task).completedAt;
            expect(completedAt).not.toBeNull();
            const still = await as(admin)
                .patch(w(`/tasks/${task}`))
                .send({ title: 'Call Sam again' })
                .expect(200);
            expect((still.body as Task).completedAt).toBe(completedAt);
            const reopened = await as(admin)
                .patch(w(`/tasks/${task}`))
                .send({ status: 'in_progress' })
                .expect(200);
            expect((reopened.body as Task).completedAt).toBeNull();
        });

        it('is visible to its assignee even when they cannot see its targets', async () => {
            // The rep cannot see adminsPerson, but the task is theirs.
            await as(rep)
                .get(w(`/tasks/${task}`))
                .expect(200);
            const mine = await as(rep)
                .get(w(`/tasks?assigneeId=${repMemberId}`))
                .expect(200);
            expect((mine.body as Page<Task>).items.map((t) => t.id)).toEqual([task]);
            await as(rep)
                .get(w(`/tasks?assigneeId=${adminMemberId}`))
                .expect(403);
            await as(admin)
                .get(w(`/tasks?assigneeId=${repMemberId}`))
                .expect(200);
            await as(admin).get(w('/tasks')).expect(400);
        });

        it('refuses an assignee who is not a member, and a target outside the caller’s scope', async () => {
            await as(admin)
                .post(w('/tasks'))
                .send({ title: 'Nope', targets: [{ type: 'person', id: adminsPerson }], assigneeId: otherPerson })
                .expect(422);
            await as(rep)
                .post(w('/tasks'))
                .send({ title: 'Nope', targets: [{ type: 'person', id: adminsPerson }] })
                .expect(422);
        });
    });

    describe('attachments', () => {
        let attachment: string;

        it('uploads a file onto a record, streams it back, and only through a row the caller can see', async () => {
            const uploaded = await as(admin)
                .post(w(`/attachments?target=person:${adminsPerson}`))
                .attach('file', Buffer.from('hello attachment'), { filename: 'hello.txt', contentType: 'text/plain' })
                .expect(201);
            const body = uploaded.body as Attachment;
            attachment = body.id;
            expect(body).toMatchObject({ name: 'hello.txt', mime: 'text/plain', sizeBytes: 16 });
            expect(body.target).toEqual({ type: 'person', id: adminsPerson });

            const content = await as(admin)
                .get(w(`/attachments/${attachment}/content`))
                .expect(200);
            expect(content.text).toBe('hello attachment');
            expect(content.headers['content-type']).toContain('text/plain');
            expect(content.headers['content-disposition']).toContain("filename*=UTF-8''hello.txt");
            expect(content.headers['cache-control']).toBe('private, no-store');

            await as(rep)
                .get(w(`/attachments/${attachment}/content`))
                .expect(404);
            await as(other).get(`/api/w/${otherWorkspace}/attachments/${attachment}/content`).expect(404);
            const listed = await as(admin)
                .get(w(`/attachments?target=person:${adminsPerson}`))
                .expect(200);
            expect((listed.body as Attachment[]).map((a) => a.id)).toEqual([attachment]);
        });

        it('refuses a target the caller cannot see before storing a byte, and a type off the allowlist', async () => {
            await as(rep)
                .post(w(`/attachments?target=person:${adminsPerson}`))
                .attach('file', Buffer.from('x'), { filename: 'x.txt', contentType: 'text/plain' })
                .expect(422);
            await as(admin)
                .post(w(`/attachments?target=person:${adminsPerson}`))
                .attach('file', Buffer.from('MZ'), { filename: 'x.exe', contentType: 'application/octet-stream' })
                .expect(415);
            await as(admin)
                .post(w(`/attachments?target=person:${adminsPerson}`))
                .send({ not: 'multipart' })
                .expect(400);
        });

        it('deletes softly, keeps the bytes, and restores', async () => {
            await as(admin)
                .delete(w(`/attachments/${attachment}`))
                .expect(204);
            await as(admin)
                .get(w(`/attachments/${attachment}/content`))
                .expect(404);
            const trash = await as(admin)
                .get(w(`/attachments/deleted?target=person:${adminsPerson}`))
                .expect(200);
            expect((trash.body as Attachment[]).map((a) => a.id)).toEqual([attachment]);
            await as(admin)
                .post(w(`/attachments/${attachment}/restore`))
                .expect(201);
            const content = await as(admin)
                .get(w(`/attachments/${attachment}/content`))
                .expect(200);
            expect(content.text).toBe('hello attachment');
            const types = (await events.read()).filter((e) => e.recordId === attachment).map((e) => e.type);
            expect(types).toEqual(['attachment.created', 'attachment.deleted', 'attachment.restored']);
        });
    });
});

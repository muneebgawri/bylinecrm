import 'reflect-metadata';
import { type INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE, type NotificationsView } from '@bylinecrm/shared';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_OPTIONS, configureApp } from '../../src/app';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/infra/prisma.service';
import { TaskNotificationsService } from '../../src/notifications/task-notifications.service';
import { deliverMail, mailTo, verifyAddress } from '../support/mail';
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

const HOUR = 60 * 60 * 1000;

/**
 * Members hear about their tasks (#192) — a sequence's "Call if no reply" no longer waits silently on
 * the person's record. A task assigned to someone else tells them (the bell); a task coming due tells
 * its assignee once; each morning a member with tasks due or overdue gets one email listing them,
 * unless they turned it off. Each member sees only their own notifications, and one workspace never
 * another's.
 */
describe('#192 task notifications: the bell, due reminders and the daily digest', () => {
    let app: INestApplication;
    let http: () => request.Agent;
    let owner: PrismaService;
    let notify: TaskNotificationsService;
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const password = 'correct horse battery staple';
    const anaEmail = `notify-ana-${stamp}@example.test`;
    const benEmail = `notify-ben-${stamp}@example.test`;
    let admin: Browser;
    let ana: Browser;
    let ben: Browser;
    let other: Browser;
    let workspace: string;
    let otherWorkspace: string;
    let adminId: string;
    let anaId: string;
    let benId: string;
    let person: string;

    const as = (who: Browser) => ({
        get: (path: string) => http().get(path).set('Cookie', who.cookie),
        post: (path: string) => http().post(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
        patch: (path: string) => http().patch(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
        put: (path: string) => http().put(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
    });
    const w = (path: string, id = workspace) => `/api/w/${id}${path}`;
    const inbox = async (who: Browser, ws = workspace): Promise<NotificationsView> =>
        (await as(who).get(w('/notifications', ws)).expect(200)).body as NotificationsView;
    const task = async (body: Record<string, unknown>, who = admin): Promise<string> => {
        const res = await as(who)
            .post(w('/tasks'))
            .send({ targets: [{ type: 'person', id: person }], ...body });
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        await settle(app);
        return (res.body as { id: string }).id;
    };

    beforeAll(async () => {
        const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
        app = configureApp(moduleRef.createNestApplication<NestExpressApplication>(APP_OPTIONS));
        await app.init();
        http = () => request(app.getHttpServer() as Parameters<typeof request>[0]);
        owner = app.get(PrismaService);
        notify = app.get(TaskNotificationsService);

        const signUp = async (email: string, name: string) => {
            const res = await http().post('/api/auth/signup').send({ email, password, workspaceName: name });
            expect(res.status).toBe(201);
            await verifyAddress(app, http, email);
            return { browser: browserFrom(res), workspace: (res.body as { workspace: { id: string } }).workspace.id };
        };
        ({ browser: admin, workspace } = await signUp(`notify-admin-${stamp}@example.test`, `Notify ${stamp}`));
        ({ browser: other, workspace: otherWorkspace } = await signUp(
            `notify-other-${stamp}@example.test`,
            `Notify other ${stamp}`,
        ));
        const role = await as(admin)
            .post(w('/roles'))
            .send({ name: 'account manager', capabilities: ['record:read', 'record:write', 'task:write'] })
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
        ana = await join(anaEmail);
        ben = await join(benEmail);
        const members = (await as(admin).get(w('/members')).expect(200)).body as { id: string; email: string }[];
        const id = (email: string) => members.find((m) => m.email === email)!.id;
        adminId = id(`notify-admin-${stamp}@example.test`);
        anaId = id(anaEmail);
        benId = id(benEmail);
        person = (
            (await as(admin).post(w('/people')).send({ nameFirst: 'Pat', nameLast: 'Prospect' }).expect(201)).body as {
                id: string;
            }
        ).id;
    });

    afterAll(async () => {
        await app?.close();
    });

    it('tells a member when a task is assigned to them — once, never for their own — and only them', async () => {
        const id = await task({ title: `Call if no reply ${stamp}`, assigneeId: anaId });
        const mine = await inbox(ana);
        expect(mine.unread).toBe(1);
        expect(mine.items).toHaveLength(1);
        expect(mine.items[0]).toMatchObject({
            kind: 'task_assigned',
            readAt: null,
            task: { id, title: `Call if no reply ${stamp}`, targets: [{ type: 'person', id: person }] },
        });
        // The event delivered again changes nothing.
        await settle(app);
        expect((await inbox(ana)).items).toHaveLength(1);
        // Nobody else hears of it, and assigning yourself tells nobody.
        expect((await inbox(ben)).items).toHaveLength(0);
        await task({ title: `Note to self ${stamp}`, assigneeId: adminId });
        expect((await inbox(admin)).items).toHaveLength(0);
        // Handed on to Ben: Ben hears of it.
        await as(admin)
            .patch(w(`/tasks/${id}`))
            .send({ assigneeId: benId })
            .expect(200);
        await settle(app);
        expect((await inbox(ben)).items).toMatchObject([{ kind: 'task_assigned', task: { id } }]);
    });

    it('reads one or all, and a member cannot touch another’s', async () => {
        const first = (await inbox(ana)).items[0]!;
        await as(ben)
            .post(w('/notifications/read'))
            .send({ ids: [first.id] })
            .expect(204);
        expect((await inbox(ana)).unread).toBe(1);
        await as(ana)
            .post(w('/notifications/read'))
            .send({ ids: [first.id] })
            .expect(204);
        expect((await inbox(ana)).unread).toBe(0);
        await task({ title: `Another ${stamp}`, assigneeId: anaId });
        expect((await inbox(ana)).unread).toBe(1);
        await as(ana).post(w('/notifications/read')).send({}).expect(204);
        expect((await inbox(ana)).unread).toBe(0);
    });

    it('reminds the assignee once when a task comes due; a done task and a task due as it is made remind nobody', async () => {
        const now = Date.now();
        const due = await task({
            title: `Due soon ${stamp}`,
            assigneeId: anaId,
            dueAt: new Date(now + HOUR).toISOString(),
        });
        const done = await task({
            title: `Done already ${stamp}`,
            assigneeId: anaId,
            dueAt: new Date(now + HOUR).toISOString(),
        });
        await as(admin)
            .patch(w(`/tasks/${done}`))
            .send({ status: 'done' })
            .expect(200);
        // Made due now, as a sequence's task step does: being assigned is the reminder.
        const atOnce = await task({ title: `Due now ${stamp}`, assigneeId: anaId, dueAt: new Date(now).toISOString() });
        await settle(app);

        await notify.remindDue(new Date(now + 2 * HOUR));
        await notify.remindDue(new Date(now + 3 * HOUR));
        const reminders = (await inbox(ana)).items.filter((n) => n.kind === 'task_due');
        expect(reminders.map((n) => n.task.id)).toEqual([due]);
        expect(reminders.map((n) => n.task.id)).not.toContain(atOnce);
    });

    it('sends each member one morning digest of what is due or overdue — nothing when nothing is, never twice a day, never once turned off', async () => {
        const morning = new Date(Date.now() + 5 * HOUR);
        await owner.task.create({
            data: {
                workspaceId: workspace,
                title: `Overdue ${stamp}`,
                assigneeId: anaId,
                dueAt: new Date(morning.getTime() - 48 * HOUR),
                createdBy: { kind: 'system', id: null },
            },
        });
        const before = mailTo(anaEmail, 'task_digest').length;
        await notify.sendDigests(morning);
        await notify.sendDigests(new Date(morning.getTime() + HOUR));
        await deliverMail(app, () => morning);
        const digests = mailTo(anaEmail, 'task_digest');
        expect(digests).toHaveLength(before + 1);
        expect(digests.at(-1)!.text).toContain(`Overdue ${stamp}`);
        expect(digests.at(-1)!.text).toContain(`Due soon ${stamp}`);
        expect(digests.at(-1)!.text).not.toContain(`Done already ${stamp}`);
        // Ben's only task is not due until much later: nothing is sent to him.
        expect(mailTo(benEmail, 'task_digest')).toHaveLength(0);

        // Ana turns it off: the next morning sends her nothing.
        expect(
            (
                (await as(ana).put(w('/notification-settings')).send({ taskDigest: false }).expect(200)).body as {
                    taskDigest: boolean;
                }
            ).taskDigest,
        ).toBe(false);
        const tomorrow = new Date(morning.getTime() + 24 * HOUR);
        await notify.sendDigests(tomorrow);
        await deliverMail(app, () => tomorrow);
        expect(mailTo(anaEmail, 'task_digest')).toHaveLength(before + 1);
        expect((await as(ana).get(w('/notification-settings')).expect(200)).body).toEqual({ taskDigest: false });
    });

    it('lists my open tasks, soonest due first, each with what it is about; done ones and others’ are not mine', async () => {
        const res = await as(ana).get(w('/my-tasks')).expect(200);
        const mine = res.body as { id: string; title: string; dueAt: string | null; targets: { label: string }[] }[];
        const titles = mine.map((t) => t.title);
        expect(titles).toContain(`Due soon ${stamp}`);
        expect(titles).toContain(`Overdue ${stamp}`);
        expect(titles).not.toContain(`Done already ${stamp}`);
        expect(titles).not.toContain(`Note to self ${stamp}`);
        // Soonest first; no due date last.
        const dues = mine.map((t) => t.dueAt).filter((d): d is string => d !== null);
        expect(dues).toEqual([...dues].sort());
        expect(mine.find((t) => t.title === `Due soon ${stamp}`)!.targets).toEqual([
            { type: 'person', id: person, label: 'Pat Prospect' },
        ]);
        expect((await as(ben).get(w('/my-tasks')).expect(200)).body).not.toContainEqual(
            expect.objectContaining({ title: `Due soon ${stamp}` }),
        );
    });

    it('another workspace sees none of it', async () => {
        expect((await inbox(other, otherWorkspace)).items).toHaveLength(0);
        expect((await as(other).get(w('/notifications'))).status).toBe(403);
        const anas = (await inbox(ana)).items[0]!;
        await owner.notification.update({ where: { id: anas.id }, data: { readAt: null } });
        // Marking it read from another workspace (or every one there) leaves Ana's untouched.
        await as(other)
            .post(w('/notifications/read', otherWorkspace))
            .send({ ids: [anas.id] })
            .expect(204);
        await as(other).post(w('/notifications/read', otherWorkspace)).send({}).expect(204);
        expect(await owner.notification.count({ where: { id: anas.id, readAt: null } })).toBe(1);
        expect(await owner.notification.count({ where: { workspaceId: otherWorkspace } })).toBe(0);
        expect((await as(other).get(w('/my-tasks', otherWorkspace)).expect(200)).body).toEqual([]);
        expect((await as(other).get(w('/my-tasks'))).status).toBe(403);
    });
});

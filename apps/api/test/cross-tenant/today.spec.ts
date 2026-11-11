import 'reflect-metadata';
import { type INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE } from '@bylinecrm/shared';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_OPTIONS, configureApp } from '../../src/app';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/infra/prisma.service';
import { verifyAddress } from '../support/mail';

type Browser = { cookie: string; csrf: string };

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

interface Section {
    count: number;
    countIsExact: boolean;
    nextCursor: string | null;
    items: { id?: string; messageId?: string; name?: string; title?: string; subject?: string }[];
}
interface Today {
    member: { memberId: string };
    date: string;
    replies: Section;
    followUps: Section;
    newLeads: Section;
    tasks: Section;
    stalled: Section;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** The setup makes two workspaces, a role, an invite and a dozen records over HTTP. */
const SETUP_TIMEOUT_MS = 120_000;
const ago = (days: number) => new Date(Date.now() - days * DAY_MS);
const labels = (s: Section) => s.items.map((i) => i.name ?? i.title ?? i.subject);

/**
 * Today (#360): one member's day in five sections, read under their own row-level security — a rep sees their own
 * day only, an admin any member's, and nothing crosses a workspace. Each section is sorted most urgent first and
 * paged by its own cursor, its count over the whole set.
 */
describe('Today', () => {
    let app: INestApplication;
    let http: () => request.Agent;
    let owner: PrismaService;
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const password = 'correct horse battery staple';
    let workspace: string;
    let admin: Browser;
    let rep: Browser;
    let other: Browser;
    let repMember: string;
    let adminMember: string;
    const ids: Record<string, string> = {};
    /** Each member's company: a deal is with one, through its contact. */
    const companies = new Map<Browser, string>();
    const company = async (who: Browser, name: string) =>
        companies.set(
            who,
            (
                (
                    await as(who)
                        .post(w('/companies'))
                        .send({ name: `${name} ${stamp}` })
                        .expect(201)
                ).body as { id: string }
            ).id,
        );
    let pipelineId: string;
    let firstStage: string;

    const as = (who: Browser) => ({
        get: (path: string) => http().get(path).set('Cookie', who.cookie),
        post: (path: string) => http().post(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
    });
    const w = (path: string, ws = workspace) => `/api/w/${ws}${path}`;
    const today = async (who: Browser, query = '') =>
        (
            await as(who)
                .get(w(`/today${query}`))
                .expect(200)
        ).body as Today;

    const person = async (who: Browser, name: string) =>
        (
            (
                await as(who)
                    .post(w('/people'))
                    .send({
                        nameFirst: name,
                        nameLast: 'Today',
                        emails: { primary: `${name}-${stamp}@example.com`.toLowerCase() },
                        companyId: companies.get(who)!,
                    })
                    .expect(201)
            ).body as { id: string }
        ).id;
    const deal = async (who: Browser, name: string, contact: string, extra: Record<string, unknown> = {}) =>
        (
            (
                await as(who)
                    .post(w('/opportunities'))
                    .send({ name, pointOfContactId: contact, pipelineId, stageId: firstStage, ...extra })
                    .expect((res) => expect(res.status, JSON.stringify(res.body)).toBe(201))
            ).body as { id: string }
        ).id;
    /** A conversation: its messages in order, each from a person (inbound) or the member (outbound). */
    const thread = async (subject: string, messages: { inbound: boolean; at: Date; personId?: string }[]) => {
        const t = await owner.mailThread.create({
            data: {
                workspaceId: workspace,
                subject,
                lastMessageAt: messages.at(-1)!.at,
                messageCount: messages.length,
            },
        });
        for (const [n, m] of messages.entries()) {
            await owner.mailMessage.create({
                data: {
                    workspaceId: workspace,
                    threadId: t.id,
                    identityKey: `today:${t.id}:${n}`,
                    direction: m.inbound ? 'inbound' : 'outbound',
                    fromAddress: m.inbound ? `them-${n}@example.com` : `rep-${stamp}@example.test`,
                    sentAt: m.at,
                    subject,
                    snippet: subject,
                    participants: {
                        create: {
                            workspaceId: workspace,
                            role: 'from',
                            address: m.inbound ? `them-${n}@example.com` : `rep-${stamp}@example.test`,
                            personId: m.inbound ? (m.personId ?? null) : null,
                        },
                    },
                },
            });
        }
    };

    beforeAll(async () => {
        const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
        app = configureApp(moduleRef.createNestApplication<NestExpressApplication>(APP_OPTIONS));
        await app.init();
        http = () => request(app.getHttpServer() as Parameters<typeof request>[0]);
        owner = app.get(PrismaService);

        const signup = await http()
            .post('/api/auth/signup')
            .send({ email: `today-admin-${stamp}@example.test`, password, workspaceName: 'Today Co' })
            .expect(201);
        await verifyAddress(app, http, `today-admin-${stamp}@example.test`);
        admin = browserFrom(signup);
        workspace = (signup.body as { workspace: { id: string } }).workspace.id;

        const otherSignup = await http()
            .post('/api/auth/signup')
            .send({ email: `today-other-${stamp}@example.test`, password, workspaceName: 'Elsewhere Co' })
            .expect(201);
        await verifyAddress(app, http, `today-other-${stamp}@example.test`);
        other = browserFrom(otherSignup);

        const role = await as(admin)
            .post(w('/roles'))
            .send({
                name: 'rep',
                capabilities: ['record:read', 'record:write', 'deal:read', 'deal:edit', 'task:write'],
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
        const members = (await as(admin).get(w('/members')).expect(200)).body as { id: string; email: string }[];
        repMember = members.find((m) => m.email === `rep-${stamp}@example.test`)!.id;
        adminMember = members.find((m) => m.email === `today-admin-${stamp}@example.test`)!.id;

        // New leads: two recent, one made long ago (not new any more), one contacted.
        await company(rep, 'Rep Co');
        await company(admin, 'Admin Co');
        ids.leadOld = await person(rep, 'Lead-earlier');
        ids.leadNew = await person(rep, 'Lead-latest');
        ids.leadStale = await person(rep, 'Lead-stale');
        await owner.person.update({ where: { id: ids.leadOld }, data: { createdAt: ago(5) } });
        await owner.person.update({ where: { id: ids.leadStale }, data: { createdAt: ago(60) } });

        // Deals. Each contact is made long ago and touched when the deal says.
        ids.dueContact = await person(rep, 'Due-contact');
        ids.plannedContact = await person(rep, 'Planned-contact');
        ids.quietContact = await person(rep, 'Quiet-contact');
        ids.freshContact = await person(rep, 'Fresh-contact');
        for (const id of [ids.dueContact, ids.plannedContact, ids.quietContact, ids.freshContact]) {
            await owner.person.update({ where: { id }, data: { createdAt: ago(90) } });
        }
        const board = (await as(admin).get(w('/pipelines')).expect(200)).body as {
            id: string;
            stages: { id: string; kind: string; name: string }[];
        }[];
        pipelineId = board[0]!.id;
        const stages = board[0]!.stages.filter((s) => s.kind === 'open');
        firstStage = stages[0]!.id;
        ids.due = await deal(rep, 'Due deal', ids.dueContact);
        const yesterday = ago(1).toISOString().slice(0, 10);
        ids.planned = await deal(rep, 'Planned deal', ids.plannedContact, { nextFollowUpDate: yesterday });
        ids.quiet = await deal(rep, 'Quiet deal', ids.quietContact);
        ids.fresh = await deal(rep, 'Fresh deal', ids.freshContact);
        const longStage = stages.at(-1)!;
        // The quiet deal sits in a stage with a long cadence: nothing is due, and it has been quiet for a month.
        await owner.pipelineStage.update({ where: { id: longStage.id }, data: { cadenceDays: 60 } });
        await owner.opportunity.update({ where: { id: ids.quiet }, data: { stageId: longStage.id } });
        await owner.opportunity.update({ where: { id: ids.due }, data: { createdAt: ago(20) } });
        await owner.opportunity.update({ where: { id: ids.quiet }, data: { createdAt: ago(30) } });
        await owner.opportunityStageHistory.updateMany({
            where: { opportunityId: { in: [ids.due, ids.quiet] } },
            data: { enteredAt: ago(30) },
        });
        await owner.$executeRaw`SELECT refresh_cadence(ARRAY[${ids.due}::uuid, ${ids.planned}::uuid, ${ids.quiet}::uuid, ${ids.fresh}::uuid])`;
        // The admin's own deal never shows on the rep's day.
        const adminContact = await person(admin, 'Admin-contact');
        ids.adminDeal = await deal(admin, 'Admin deal', adminContact, { nextFollowUpDate: yesterday });

        // Tasks: overdue, today, tomorrow, done.
        const task = async (title: string, dueAt: Date, status?: string) =>
            as(rep)
                .post(w('/tasks'))
                .send({
                    title,
                    dueAt: dueAt.toISOString(),
                    assigneeId: repMember,
                    targets: [{ type: 'person', id: ids.dueContact }],
                    ...(status ? { status } : {}),
                })
                .expect(201);
        await task('Overdue task', ago(3));
        await task('Today task', new Date(Date.now() - 60_000));
        await task('Next week task', new Date(Date.now() + 7 * DAY_MS));
        await task('Done task', ago(2), 'done');

        // Mail: waiting replies, an answered one, one too old, one from someone who is not the rep's.
        await thread('Waiting long', [
            { inbound: false, at: ago(4) },
            { inbound: true, at: ago(3), personId: ids.dueContact },
        ]);
        await thread('Waiting short', [{ inbound: true, at: ago(0.1), personId: ids.leadNew }]);
        await thread('Answered', [
            { inbound: true, at: ago(2), personId: ids.quietContact },
            { inbound: false, at: ago(1) },
        ]);
        await thread('Too old', [{ inbound: true, at: ago(45), personId: ids.dueContact }]);
        await thread('Not mine', [{ inbound: true, at: ago(1), personId: adminContact }]);
    }, SETUP_TIMEOUT_MS);

    afterAll(async () => {
        await app?.close();
    });

    it('reads the rep’s own day, each section most urgent first', async () => {
        const day = await today(rep, '?timeZone=Europe/London');
        expect(day.member.memberId).toBe(repMember);
        expect(day.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(labels(day.replies)).toEqual(['Waiting long', 'Waiting short']);
        expect(labels(day.followUps)).toEqual(['Due deal', 'Planned deal']);
        expect(labels(day.newLeads)).toEqual(expect.arrayContaining(['Lead-earlier Today', 'Lead-latest Today']));
        expect(labels(day.newLeads)[0]).toBe('Lead-earlier Today');
        expect(labels(day.newLeads)).not.toContain('Lead-stale Today');
        // The planned follow-up keeps its own task, due that day (#242).
        expect(labels(day.tasks)).toEqual(['Overdue task', 'Follow up: Planned deal', 'Today task']);
        expect(labels(day.stalled)).toEqual(['Quiet deal']);
    });

    it('pages a section by its cursor, counting the whole set', async () => {
        const first = await today(rep, '?limit=2');
        expect(first.tasks).toMatchObject({ count: 3, countIsExact: true });
        expect(labels(first.tasks)).toEqual(['Overdue task', 'Follow up: Planned deal']);
        expect(first.tasks.nextCursor).not.toBeNull();
        const next = (
            await as(rep)
                .get(w(`/today/tasks?limit=2&cursor=${encodeURIComponent(first.tasks.nextCursor!)}`))
                .expect(200)
        ).body as Section;
        expect(labels(next)).toEqual(['Today task']);
        expect(next.nextCursor).toBeNull();
        await as(rep).get(w('/today/tasks?cursor=not-a-cursor')).expect(400);
    });

    it('lets an admin read any member’s day, and no one else', async () => {
        const repDay = await today(admin, `?memberId=${repMember}`);
        expect(labels(repDay.followUps)).toEqual(['Due deal', 'Planned deal']);
        const own = await today(admin);
        expect(own.member.memberId).toBe(adminMember);
        expect(labels(own.followUps)).toEqual(['Admin deal']);
        expect(labels(own.replies)).toEqual(['Not mine']);
        await as(rep)
            .get(w(`/today?memberId=${adminMember}`))
            .expect(403);
    });

    it('keeps to the workspace', async () => {
        const otherWorkspace = ((await as(other).get('/api/me/workspaces').expect(200)).body as { id: string }[])[0]!
            .id;
        const elsewhere = (await as(other).get(w('/today', otherWorkspace)).expect(200)).body as Today;
        for (const s of ['replies', 'followUps', 'newLeads', 'tasks', 'stalled'] as const) {
            expect(elsewhere[s].count).toBe(0);
        }
        await as(other)
            .get(w(`/today?memberId=${repMember}`, otherWorkspace))
            .expect(404);
        // Not a member of the workspace: refused before anything is read.
        await as(other).get(w('/today')).expect(403);
    });
});

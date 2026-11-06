import 'reflect-metadata';
import { type INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE } from '@bylinecrm/shared';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_OPTIONS, configureApp } from '../../src/app';
import { AppModule } from '../../src/app.module';
import { refreshContactStatus } from '../../src/customers/contact-status.service';
import { PrismaService } from '../../src/infra/prisma.service';
import { RlsPrismaService } from '../../src/infra/rls-prisma.service';
import { verifyAddress } from '../support/mail';
import { settle } from '../support/outbox';

function browserFrom(res: Response) {
    const raw = res.headers['set-cookie'] as string[] | undefined;
    const session = raw?.find((c) => c.startsWith(`${SESSION_COOKIE}=`))?.split(';')[0];
    const csrf = raw
        ?.find((c) => c.startsWith(`${CSRF_COOKIE}=`))
        ?.split(';')[0]
        ?.split('=')[1];
    if (!session || !csrf) throw new Error('login did not set both cookies');
    return { cookie: `${session}; ${CSRF_COOKIE}=${csrf}`, csrf };
}

type Who = { cookie: string; csrf: string };
type Stage = { id: string; name: string; kind: 'open' | 'won' | 'lost' };
type Exclusion = {
    id: string;
    address: string | null;
    domain: string | null;
    source: string;
    externalRef: string | null;
    reviewReason: string | null;
};

/**
 * #242: contact status on people, the deal fields and required lost reason, and won deals as customers — each
 * workspace's settings, exclusions and statuses its own.
 */
describe('#242 contact status, deal fields, won deals as customers', () => {
    let app: INestApplication;
    let http: () => request.Agent;
    let owner: PrismaService;
    let rls: RlsPrismaService;
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const domain = `acme-${stamp}.test`;
    let a: { who: Who; id: string };
    let b: { who: Who; id: string };
    let stages: Stage[];
    let companyId: string;
    let personId: string;

    const as = (who: Who) => ({
        get: (path: string) => http().get(path).set('Cookie', who.cookie),
        post: (path: string) => http().post(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
        put: (path: string) => http().put(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
        patch: (path: string) => http().patch(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
    });
    const w = (path: string, ws = a.id) => `/api/w/${ws}${path}`;
    const stage = (kind: Stage['kind']) => stages.find((s) => s.kind === kind)!;
    const newDeal = async (name: string) =>
        (
            (
                await as(a.who)
                    .post(w('/opportunities'))
                    .send({ name, companyId, pointOfContactId: personId })
                    .expect(201)
            ).body as { id: string }
        ).id;
    const exclusions = async (ws = a) =>
        (await as(ws.who).get(w('/outreach/exclusions', ws.id)).expect(200)).body as Exclusion[];
    const person = async () =>
        (
            await as(a.who)
                .get(w(`/people/${personId}`))
                .expect(200)
        ).body as {
            contactStatus: string;
            contactStatusOverride: string | null;
        };

    beforeAll(async () => {
        const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
        app = configureApp(moduleRef.createNestApplication<NestExpressApplication>(APP_OPTIONS));
        await app.init();
        http = () => request(app.getHttpServer() as Parameters<typeof request>[0]);
        owner = app.get(PrismaService);
        rls = app.get(RlsPrismaService);
        const signUp = async (email: string) => {
            const res = await http()
                .post('/api/auth/signup')
                .send({ email, password: 'correct horse battery staple', workspaceName: email });
            expect(res.status).toBe(201);
            await verifyAddress(app, http, email);
            return { who: browserFrom(res), id: (res.body as { workspace: { id: string } }).workspace.id };
        };
        a = await signUp(`customers-a-${stamp}@example.test`);
        b = await signUp(`customers-b-${stamp}@example.test`);
        stages = ((await as(a.who).get(w('/pipelines')).expect(200)).body as { stages: Stage[] }[])[0]!.stages;
        companyId = (
            (await as(a.who).post(w('/companies')).send({ name: 'Acme', domain }).expect(201)).body as {
                id: string;
            }
        ).id;
        personId = (
            (
                await as(a.who)
                    .post(w('/people'))
                    .send({ nameFirst: 'Ana', companyId, emails: { primary: `ana@${domain}`, additional: [] } })
                    .expect(201)
            ).body as { id: string }
        ).id;
    });

    afterAll(async () => {
        await app.close();
    });

    describe('customer exclusion settings (a new table)', () => {
        it("keeps each workspace's choice its own", async () => {
            await as(a.who)
                .put(w('/outreach/customer-exclusion-settings'))
                .send({ wonExclusionScope: 'domain' })
                .expect(200);
            expect((await as(a.who).get(w('/outreach/customer-exclusion-settings')).expect(200)).body).toEqual({
                wonExclusionScope: 'domain',
            });
            expect((await as(b.who).get(w('/outreach/customer-exclusion-settings', b.id)).expect(200)).body).toEqual({
                wonExclusionScope: 'address',
            });
        });

        it("is invisible and unwritable from the other workspace's scope", async () => {
            const seen = await rls.withWorkspace(b.id, (tx) => tx.customerExclusionSettings.findMany());
            expect(seen.map((s) => s.workspaceId)).not.toContain(a.id);
            const changed = await rls.withWorkspace(b.id, (tx) =>
                tx.customerExclusionSettings.updateMany({
                    where: { workspaceId: a.id },
                    data: { wonExclusionScope: 'address' },
                }),
            );
            expect(changed.count).toBe(0);
            await expect(
                rls.withWorkspace(b.id, (tx) =>
                    tx.customerExclusionSettings.create({ data: { workspaceId: a.id, wonExclusionScope: 'address' } }),
                ),
            ).rejects.toThrow();
        });
    });

    describe('lost reason', () => {
        it("refuses a member's move to lost without a reason, and records the one given", async () => {
            const deal = await newDeal('Lost one');
            await as(a.who)
                .post(w(`/opportunities/${deal}/move`))
                .send({ stageId: stage('lost').id, close: {} })
                .expect(400);
            const moved = await as(a.who)
                .post(w(`/opportunities/${deal}/move`))
                .send({ stageId: stage('lost').id, close: { lostReasonCode: 'timing', lostReason: 'Next quarter' } })
                .expect(201);
            expect((moved.body as { deal: { lostReasonCode: string; lostReason: string } }).deal).toMatchObject({
                lostReasonCode: 'timing',
                lostReason: 'Next quarter',
            });
            // Lost deals by reason: the deal list's group-by.
            const byReason = await as(a.who).get(w('/opportunities/group-by?field=lostReasonCode')).expect(200);
            expect(byReason.body).toContainEqual(expect.objectContaining({ value: 'timing', count: 1 }));
        });
    });

    describe('won deal makes a customer', () => {
        let won: string;

        it("excludes the contact's company domain (this workspace's setting), and only here", async () => {
            won = await newDeal('Won one');
            await as(a.who)
                .post(w(`/opportunities/${won}/move`))
                .send({ stageId: stage('won').id, close: {} })
                .expect(201);
            await settle(app);
            const mine = (await exclusions()).filter((e) => e.externalRef === won);
            expect(mine).toEqual([
                expect.objectContaining({ domain, address: null, source: 'won_deal', reviewReason: null }),
            ]);
            expect((await exclusions(b)).some((e) => e.externalRef === won)).toBe(false);
            expect((await person()).contactStatus).toBe('customer');
        });

        it('flags the exclusion when the deal is reopened, and an admin may keep it', async () => {
            await as(a.who)
                .post(w(`/opportunities/${won}/move`))
                .send({ stageId: stage('open').id })
                .expect(201);
            await settle(app);
            const flagged = (await exclusions()).find((e) => e.externalRef === won)!;
            expect(flagged.reviewReason).toBe('deal_reopened');
            await as(b.who)
                .post(w(`/outreach/exclusions/${flagged.id}/dismiss-review`, b.id))
                .expect(404);
            const kept = await as(a.who)
                .post(w(`/outreach/exclusions/${flagged.id}/dismiss-review`))
                .expect(201);
            expect((kept.body as Exclusion).reviewReason).toBeNull();
        });
    });

    describe('contact status', () => {
        it('takes an override, and Do Not Contact through the suppression list', async () => {
            const set = await as(a.who)
                .put(w(`/people/${personId}/contact-status`))
                .send({ status: 'engaged' })
                .expect(200);
            expect(set.body).toMatchObject({ contactStatus: 'engaged', contactStatusOverride: 'engaged' });
            const dnc = await as(a.who)
                .put(w(`/people/${personId}/contact-status`))
                .send({ status: 'do_not_contact' })
                .expect(200);
            expect(dnc.body).toMatchObject({ contactStatus: 'do_not_contact', contactStatusOverride: 'engaged' });
            const suppressed = await owner.suppression.findFirst({
                where: { workspaceId: a.id, address: `ana@${domain}`, removedAt: null },
            });
            expect(suppressed).not.toBeNull();
        });

        it("is not settable on another workspace's person", async () => {
            await as(b.who)
                .put(w(`/people/${personId}/contact-status`, b.id))
                .send({ status: 'engaged' })
                .expect(404);
        });
    });

    describe('contact attempts from imported emails', () => {
        let boId: string;
        const external = (ws: string, targetId: string, key: string, at: string, subject: string, status: string) =>
            owner.timelineActivity.create({
                data: {
                    workspaceId: ws,
                    targetType: 'person',
                    targetId,
                    kind: 'external.email',
                    happenedAt: new Date(at),
                    actor: { kind: 'import' },
                    properties: { email: { to: [`bo@${domain}`], subject, status } },
                    source: 'test-import',
                    idempotencyKey: `${stamp}:${key}`,
                },
            });

        beforeAll(async () => {
            boId = (
                (
                    await as(a.who)
                        .post(w('/people'))
                        .send({ nameFirst: 'Bo', companyId, emails: { primary: `bo@${domain}`, additional: [] } })
                        .expect(201)
                ).body as { id: string }
            ).id;
            await settle(app);
        });

        it('counts imported emails that went, once each, beside synced mail', async () => {
            // Counted: sent, and clicked (the latest contact).
            await external(a.id, boId, 'intro', '2026-08-01T10:00:00Z', 'Intro', 'Sent');
            await external(a.id, boId, 'third', '2026-09-21T10:00:00Z', 'Third', 'Clicked');
            // Never went: not attempts.
            await external(a.id, boId, 'failed', '2026-08-02T10:00:00Z', 'Retry', 'Failed');
            await external(a.id, boId, 'pending', '2026-08-03T10:00:00Z', 'Queued', 'Pending');
            // The synced mailbox holds this one too (same subject, five minutes apart): counted once, as mail.
            await external(a.id, boId, 'dup', '2026-09-20T10:00:00Z', '  Follow up ', 'Opened');
            // Another workspace's entry naming the same id is not this person's.
            await external(b.id, boId, 'other-tenant', '2026-10-01T10:00:00Z', 'Elsewhere', 'Sent');
            const thread = await owner.mailThread.create({
                data: { workspaceId: a.id, subject: 'Follow up', lastMessageAt: new Date('2026-09-20T10:05:00Z') },
            });
            await owner.mailMessage.create({
                data: {
                    workspaceId: a.id,
                    threadId: thread.id,
                    identityKey: `${stamp}:dup`,
                    direction: 'outbound',
                    fromAddress: `customers-a-${stamp}@example.test`,
                    sentAt: new Date('2026-09-20T10:05:00Z'),
                    subject: 'follow UP',
                    participants: {
                        create: { workspaceId: a.id, role: 'to', address: `bo@${domain}`, personId: boId },
                    },
                },
            });

            await rls.withWorkspace(a.id, (tx) => refreshContactStatus(tx, [boId]));
            const bo = await owner.person.findUniqueOrThrow({ where: { id: boId } });
            expect(bo.contactAttempts).toBe(3); // the synced mail, Intro, Third
            expect(bo.lastContactedAt?.toISOString()).toBe('2026-09-21T10:00:00.000Z');
            expect(bo.contactStatus).toBe('unresponsive');
        });

        it('finds a person’s imported emails from the timeline index under row-level security', async () => {
            // With sequential scans priced out, a plan still reading the table means no index may serve it: under
            // RLS only leakproof conditions (uuid equality) may use one. Mirrors the function's imported-email part.
            const plan = await rls.withWorkspace(a.id, async (tx) => {
                await tx.$executeRaw`SET LOCAL enable_seqscan = off`;
                const rows = await tx.$queryRaw<{ 'QUERY PLAN': string }[]>`
                    EXPLAIN SELECT ext.* FROM people p CROSS JOIN LATERAL (
                        SELECT count(*), max(t.happened_at) FROM timeline_activities t
                        WHERE t.workspace_id = p.workspace_id AND t.target_id = p.id
                          AND t.target_type = 'person' AND t.kind = 'external.email'
                          AND coalesce(t.properties -> 'email' ->> 'status', '') NOT IN ('Failed', 'Pending')
                    ) ext WHERE p.id = ANY(${[boId]}::uuid[])`;
                return rows.map((r) => r['QUERY PLAN']).join('\n');
            });
            expect(plan).toContain('timeline_activities_record_idx');
            expect(plan).not.toMatch(/Seq Scan on timeline_activities/);
        });
    });

    describe('next follow-up date', () => {
        it('keeps one open task due that day, and removes it when cleared', async () => {
            const deal = await newDeal('Follow me');
            const set = await as(a.who)
                .patch(w(`/opportunities/${deal}`))
                .send({ nextFollowUpDate: '2026-11-02' })
                .expect(200);
            const taskId = (set.body as { followUpTaskId: string }).followUpTaskId;
            expect(taskId).toBeTruthy();
            const moved = await as(a.who)
                .patch(w(`/opportunities/${deal}`))
                .send({ nextFollowUpDate: '2026-11-09' })
                .expect(200);
            expect((moved.body as { followUpTaskId: string }).followUpTaskId).toBe(taskId);
            const task = await owner.task.findUnique({ where: { id: taskId } });
            expect(task?.dueAt?.toISOString()).toBe('2026-11-09T00:00:00.000Z');
            await as(a.who)
                .patch(w(`/opportunities/${deal}`))
                .send({ nextFollowUpDate: null })
                .expect(200);
            expect((await owner.task.findUnique({ where: { id: taskId } }))?.deletedAt).not.toBeNull();
        });
    });
});

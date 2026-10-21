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

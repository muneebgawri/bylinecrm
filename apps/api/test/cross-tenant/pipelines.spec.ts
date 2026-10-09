import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { CSRF_COOKIE, CSRF_HEADER, DEFAULT_STAGES, SESSION_COOKIE, type DomainEvent } from '@bylinecrm/shared';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { StageRulesService } from '../../src/pipelines/stage-rules.service';

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

interface Stage {
    id: string;
    name: string;
    position: number;
    kind: string;
}
interface Pipeline {
    id: string;
    name: string;
    isDefault: boolean;
    stages: Stage[];
}
interface Deal {
    id: string;
    pipelineId: string;
    stageId: string;
    stageEnteredAt: string;
    daysInStage: number;
    closedAt: string | null;
    lostReason: string | null;
    amount: { amountMinor: number; currency: string } | null;
    ownerId: string | null;
}
interface History {
    fromStageId: string | null;
    toStageId: string;
    reason: string;
    actor: { kind: string; id: string | null };
}
interface Board {
    columns: { stage: Stage; count: number; amountMinorByCurrency: Record<string, number>; deals: Deal[] }[];
}

/**
 * Pipelines end to end: every workspace starts with the default pipeline; a deal is born in its
 * first stage with a history row; moves write history and the close columns; a rule moves deals
 * forward only, never twice, and never across workspaces; board totals are the caller's scope
 * only; a stage with deals stays.
 */
describe('pipelines, stages, history, rules', () => {
    let app: INestApplication;
    let http: () => request.Agent;
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const password = 'correct horse battery staple';
    let admin: Browser;
    let rep: Browser;
    let other: Browser;
    let workspace: string;
    let otherWorkspace: string;
    let repMemberId: string;
    let pipeline: Pipeline;
    let otherPipeline: Pipeline;
    const stage = (name: string) => pipeline.stages.find((s) => s.name === name)!;
    const events: DomainEvent[] = [];

    const as = (who: Browser) => ({
        get: (path: string) => http().get(path).set('Cookie', who.cookie),
        post: (path: string) => http().post(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
        patch: (path: string) => http().patch(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
        put: (path: string) => http().put(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
        delete: (path: string) => http().delete(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
    });
    const w = (path: string) => `/api/w/${workspace}${path}`;

    async function person(who: Browser, ws: string, first: string): Promise<string> {
        const res = await as(who).post(`/api/w/${ws}/people`).send({ nameFirst: first, nameLast: 'Test' }).expect(201);
        return (res.body as { id: string }).id;
    }
    async function deal(who: Browser, ws: string, name: string, extra: Record<string, unknown> = {}): Promise<Deal> {
        const res = await as(who)
            .post(`/api/w/${ws}/opportunities`)
            .send({ name, ...extra })
            .expect(201);
        return res.body as Deal;
    }
    const replied = (ws: string, personId: string): DomainEvent => ({
        type: 'email.replied',
        object: 'email',
        workspaceId: ws,
        actor: { kind: 'system', id: null },
        occurredAt: new Date().toISOString(),
        recordId: `message-${stamp}`,
        related: [{ type: 'person', id: personId }],
    });

    beforeAll(async () => {
        app = await createApp();
        await app.init();
        http = () => request(app.getHttpServer());
        app.get(EventEmitter2).on('deal.*', (event: DomainEvent) => events.push(event));

        const signup = await http()
            .post('/api/auth/signup')
            .send({ email: `admin-${stamp}@example.test`, password, workspaceName: 'Pipes Co' })
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
                capabilities: ['record:read', 'record:write', 'deal:read', 'deal:edit', 'deal:move'],
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
        repMemberId = (members.body as { id: string; email: string }[]).find(
            (m) => m.email === `rep-${stamp}@example.test`,
        )!.id;

        pipeline = ((await as(admin).get(w('/pipelines')).expect(200)).body as Pipeline[])[0]!;
        otherPipeline = (
            (await as(other).get(`/api/w/${otherWorkspace}/pipelines`).expect(200)).body as Pipeline[]
        )[0]!;
    });

    afterAll(async () => {
        await app.close();
    });

    describe('the default pipeline', () => {
        it('exists for a new workspace with the default stages in order', () => {
            expect(pipeline.isDefault).toBe(true);
            expect(pipeline.stages.map((s) => s.name)).toEqual(DEFAULT_STAGES.map((s) => s.name));
            expect(pipeline.stages.map((s) => s.position)).toEqual(DEFAULT_STAGES.map((_, i) => i + 1));
        });

        it('is each workspace’s own', () => {
            expect(otherPipeline.id).not.toBe(pipeline.id);
        });
    });

    describe('a deal’s place', () => {
        it('is born in the first stage with a history row and zero days in stage', async () => {
            const d = await deal(admin, workspace, 'Born');
            expect(d.pipelineId).toBe(pipeline.id);
            expect(d.stageId).toBe(stage('New').id);
            expect(d.daysInStage).toBe(0);
            expect(d.closedAt).toBeNull();
            const history = (
                await as(admin)
                    .get(w(`/opportunities/${d.id}/history`))
                    .expect(200)
            ).body as History[];
            expect(history).toHaveLength(1);
            expect(history[0]).toMatchObject({ fromStageId: null, toStageId: stage('New').id, reason: 'manual' });
        });

        it('may start in a named open stage, never in a closed one or another pipeline’s stage', async () => {
            const d = await deal(admin, workspace, 'Named', { stageId: stage('Replied').id });
            expect(d.stageId).toBe(stage('Replied').id);
            await as(admin)
                .post(w('/opportunities'))
                .send({ name: 'Nope', stageId: stage('Won').id })
                .expect(422);
            await as(admin)
                .post(w('/opportunities'))
                .send({ name: 'Nope', stageId: otherPipeline.stages[0]!.id })
                .expect(422);
        });

        it('moves forward by hand, writing history and the stage_changed event', async () => {
            const d = await deal(admin, workspace, 'Forward');
            events.length = 0;
            const moved = await as(admin)
                .post(w(`/opportunities/${d.id}/move`))
                .send({ stageId: stage('Contacted').id })
                .expect(201);
            const body = moved.body as { deal: Deal; rulesThatMayMoveItForward: unknown[] };
            expect(body.deal.stageId).toBe(stage('Contacted').id);
            expect(body.rulesThatMayMoveItForward).toEqual([]);
            const history = (
                await as(admin)
                    .get(w(`/opportunities/${d.id}/history`))
                    .expect(200)
            ).body as History[];
            expect(history.map((h) => h.reason)).toEqual(['manual', 'manual']);
            expect(history[0]).toMatchObject({ fromStageId: stage('New').id, toStageId: stage('Contacted').id });
            expect(events.map((e) => e.type)).toEqual(['deal.stage_changed']);
            expect(events[0]?.object).toBe('opportunity');
            expect(events[0]?.stage).toMatchObject({
                fromStageId: stage('New').id,
                toStageId: stage('Contacted').id,
                reason: 'manual',
            });
            expect(events[0]?.diff).toEqual({ stageId: { from: stage('New').id, to: stage('Contacted').id } });
        });

        it('leaves exactly one deal.stage_changed entry on the deal’s timeline per move', async () => {
            const d = await deal(admin, workspace, 'On the timeline');
            await as(admin)
                .post(w(`/opportunities/${d.id}/move`))
                .send({ stageId: stage('Contacted').id })
                .expect(201);
            const page = (
                await as(admin)
                    .get(w(`/timeline?target=opportunity:${d.id}&kinds=deal.stage_changed`))
                    .expect(200)
            ).body as {
                items: {
                    kind: string;
                    target: { type: string; id: string };
                    properties: { diff?: Record<string, unknown> };
                }[];
            };
            expect(page.items).toHaveLength(1);
            expect(page.items[0]).toMatchObject({
                kind: 'deal.stage_changed',
                target: { type: 'opportunity', id: d.id },
            });
            expect(page.items[0]?.properties.diff).toEqual({
                stageId: { from: stage('New').id, to: stage('Contacted').id },
            });
        });

        it('refuses a stage of another pipeline, and a close without its details', async () => {
            const d = await deal(admin, workspace, 'Strict');
            await as(admin)
                .post(w(`/opportunities/${d.id}/move`))
                .send({ stageId: otherPipeline.stages[1]!.id })
                .expect(422);
            await as(admin)
                .post(w(`/opportunities/${d.id}/move`))
                .send({ stageId: stage('Won').id })
                .expect(400);
        });

        it('closes as won with the amount, emits deal.won, and reopens clearing the close', async () => {
            const d = await deal(admin, workspace, 'Winner', { amount: { amountMinor: 100 } });
            events.length = 0;
            const won = (
                await as(admin)
                    .post(w(`/opportunities/${d.id}/move`))
                    .send({ stageId: stage('Won').id, close: { wonAmount: { amountMinor: 1250000 } } })
                    .expect(201)
            ).body as { deal: Deal };
            expect(won.deal.closedAt).not.toBeNull();
            expect(won.deal.amount).toEqual({ amountMinor: 1250000, currency: 'USD' });
            expect(events.map((e) => e.type)).toEqual(['deal.stage_changed', 'deal.won']);
            const history = (
                await as(admin)
                    .get(w(`/opportunities/${d.id}/history`))
                    .expect(200)
            ).body as History[];
            expect(history[0]?.reason).toBe('close');

            const reopened = (
                await as(admin)
                    .post(w(`/opportunities/${d.id}/move`))
                    .send({ stageId: stage('Meeting').id })
                    .expect(201)
            ).body as { deal: Deal };
            expect(reopened.deal.closedAt).toBeNull();
            expect(reopened.deal.stageId).toBe(stage('Meeting').id);
        });

        it('closes as lost with the reason and emits deal.lost', async () => {
            const d = await deal(admin, workspace, 'Loser');
            events.length = 0;
            const lost = (
                await as(admin)
                    .post(w(`/opportunities/${d.id}/move`))
                    .send({ stageId: stage('Lost').id, close: { lostReason: 'went with a competitor' } })
                    .expect(201)
            ).body as { deal: Deal };
            expect(lost.deal.lostReason).toBe('went with a competitor');
            expect(events.map((e) => e.type)).toEqual(['deal.stage_changed', 'deal.lost']);
        });

        it('cannot be moved through a plain patch: the stage is not a column a patch may set', async () => {
            const d = await deal(admin, workspace, 'Patched');
            const patched = (
                await as(admin)
                    .patch(w(`/opportunities/${d.id}`))
                    .send({ name: 'Patched!', stageId: stage('Won').id })
                    .expect(200)
            ).body as Deal;
            expect(patched.stageId).toBe(d.stageId);
            expect(patched.closedAt).toBeNull();
        });

        it('is out of reach of an own-scoped member who does not own it', async () => {
            const d = await deal(admin, workspace, 'Admins');
            await as(rep)
                .post(w(`/opportunities/${d.id}/move`))
                .send({ stageId: stage('Contacted').id })
                .expect(404);
            await as(rep)
                .get(w(`/opportunities/${d.id}/history`))
                .expect(404);
        });
    });

    describe('stage rules', () => {
        let rulePerson: string;

        it('are created on the pipeline, targeting an open stage only, once per event', async () => {
            await as(admin)
                .post(w(`/pipelines/${pipeline.id}/rules`))
                .send({ event: 'email.replied', toStageId: stage('Won').id })
                .expect(422);
            await as(admin)
                .post(w(`/pipelines/${pipeline.id}/rules`))
                .send({ event: 'email.replied', toStageId: stage('Replied').id })
                .expect(201);
            await as(admin)
                .post(w(`/pipelines/${pipeline.id}/rules`))
                .send({ event: 'email.replied', toStageId: stage('Replied').id })
                .expect(409);
            await as(rep)
                .post(w(`/pipelines/${pipeline.id}/rules`))
                .send({ event: 'meeting.booked', toStageId: stage('Meeting').id })
                .expect(403);
        });

        it('move the person’s deals forward to the stage, writing history as the rule, and not twice', async () => {
            rulePerson = await person(admin, workspace, 'Replier');
            const d = await deal(admin, workspace, 'Ruled', { pointOfContactId: rulePerson });
            events.length = 0;
            const rules = app.get(StageRulesService);
            expect(await rules.apply(replied(workspace, rulePerson))).toBe(1);
            expect(await rules.apply(replied(workspace, rulePerson))).toBe(0);
            const after = (
                await as(admin)
                    .get(w(`/opportunities/${d.id}`))
                    .expect(200)
            ).body as Deal;
            expect(after.stageId).toBe(stage('Replied').id);
            const history = (
                await as(admin)
                    .get(w(`/opportunities/${d.id}/history`))
                    .expect(200)
            ).body as History[];
            expect(history).toHaveLength(2);
            expect(history[0]).toMatchObject({ reason: 'rule', actor: { kind: 'rule' } });
            expect((history[0]?.actor as { id: string | null }).id).toBeTruthy();
            expect(events.filter((e) => e.type === 'deal.stage_changed')).toHaveLength(1);
        });

        it('never move a deal backward unless the rule allows it', async () => {
            const d = await deal(admin, workspace, 'Ahead', {
                pointOfContactId: rulePerson,
                stageId: stage('Meeting').id,
            });
            expect(await app.get(StageRulesService).apply(replied(workspace, rulePerson))).toBe(0);
            expect(
                (
                    (
                        await as(admin)
                            .get(w(`/opportunities/${d.id}`))
                            .expect(200)
                    ).body as Deal
                ).stageId,
            ).toBe(stage('Meeting').id);
        });

        it('in workspace A never move a deal in workspace B', async () => {
            const otherPerson = await person(other, otherWorkspace, 'Stranger');
            const d = await deal(other, otherWorkspace, 'Elsewhere', { pointOfContactId: otherPerson });
            // A's rule fed B's person: the policies show A's engine nothing of B.
            expect(await app.get(StageRulesService).apply(replied(workspace, otherPerson))).toBe(0);
            // B has no rule: nothing moves there either.
            expect(await app.get(StageRulesService).apply(replied(otherWorkspace, otherPerson))).toBe(0);
            const after = (await as(other).get(`/api/w/${otherWorkspace}/opportunities/${d.id}`).expect(200))
                .body as Deal;
            expect(after.stageId).toBe(otherPipeline.stages[0]!.id);
        });

        it('fire from the event bus', async () => {
            const p = await person(admin, workspace, 'Bus');
            const d = await deal(admin, workspace, 'Via bus', { pointOfContactId: p });
            await app.get(EventEmitter2).emitAsync('email.replied', replied(workspace, p));
            const after = (
                await as(admin)
                    .get(w(`/opportunities/${d.id}`))
                    .expect(200)
            ).body as Deal;
            expect(after.stageId).toBe(stage('Replied').id);
        });

        it('are named when a member moves a deal back past them', async () => {
            const d = await deal(admin, workspace, 'Back', { stageId: stage('Meeting').id });
            const moved = (
                await as(admin)
                    .post(w(`/opportunities/${d.id}/move`))
                    .send({ stageId: stage('New').id })
                    .expect(201)
            ).body as { rulesThatMayMoveItForward: { event: string }[] };
            expect(moved.rulesThatMayMoveItForward.map((r) => r.event)).toEqual(['email.replied']);
        });
    });

    describe('the board', () => {
        it('sums only what the caller can see', async () => {
            await deal(admin, workspace, 'Board admin', {
                amount: { amountMinor: 50000 },
                stageId: stage('Contacted').id,
            });
            await deal(rep, workspace, 'Board rep', { amount: { amountMinor: 7000 }, stageId: stage('Contacted').id });

            const repBoard = (
                await as(rep)
                    .get(w(`/pipelines/${pipeline.id}/board`))
                    .expect(200)
            ).body as Board;
            const repColumn = repBoard.columns.find((c) => c.stage.name === 'Contacted')!;
            expect(repColumn.count).toBe(1);
            expect(repColumn.amountMinorByCurrency).toEqual({ USD: 7000 });
            expect(repColumn.deals.every((d) => d.ownerId === repMemberId)).toBe(true);

            const adminBoard = (
                await as(admin)
                    .get(w(`/pipelines/${pipeline.id}/board`))
                    .expect(200)
            ).body as Board;
            const adminColumn = adminBoard.columns.find((c) => c.stage.name === 'Contacted')!;
            expect(adminColumn.count).toBeGreaterThanOrEqual(2);
            expect(adminColumn.amountMinorByCurrency.USD).toBeGreaterThanOrEqual(57000);
        });

        it('is another workspace’s pipeline to nobody else', async () => {
            await as(admin)
                .get(w(`/pipelines/${otherPipeline.id}/board`))
                .expect(404);
        });
    });

    describe('configuring stages', () => {
        it('refuses to delete a stage with deals in it, or the first stage’s openness', async () => {
            await as(admin)
                .delete(w(`/pipelines/${pipeline.id}/stages/${stage('New').id}`))
                .expect(409);
            await as(admin)
                .patch(w(`/pipelines/${pipeline.id}/stages/${stage('New').id}`))
                .send({ kind: 'lost' })
                .expect(400);
        });

        it('adds, reorders and removes an empty stage', async () => {
            const added = (
                await as(admin)
                    .post(w(`/pipelines/${pipeline.id}/stages`))
                    .send({ name: 'Proposal', probability: 50, colour: 'info' })
                    .expect(201)
            ).body as Stage;
            expect(added.position).toBe(7);
            const ids = pipeline.stages.map((s) => s.id);
            const reordered = (
                await as(admin)
                    .put(w(`/pipelines/${pipeline.id}/stages/order`))
                    .send({ stageIds: [ids[0], ids[1], ids[2], ids[3], added.id, ids[4], ids[5]] })
                    .expect(200)
            ).body as Pipeline;
            expect(reordered.stages.map((s) => s.name)[4]).toBe('Proposal');
            await as(admin)
                .delete(w(`/pipelines/${pipeline.id}/stages/${added.id}`))
                .expect(204);
            const after = (
                await as(admin)
                    .get(w(`/pipelines/${pipeline.id}`))
                    .expect(200)
            ).body as Pipeline;
            expect(after.stages.map((s) => s.position)).toEqual([1, 2, 3, 4, 5, 6]);
        });

        it('keeps the default pipeline and a pipeline with deals', async () => {
            await as(admin)
                .delete(w(`/pipelines/${pipeline.id}`))
                .expect(409);
            const second = (await as(admin).post(w('/pipelines')).send({ name: 'Partners' }).expect(201))
                .body as Pipeline;
            expect(second.stages).toHaveLength(DEFAULT_STAGES.length);
            await deal(admin, workspace, 'Partner deal', { pipelineId: second.id });
            await as(admin)
                .delete(w(`/pipelines/${second.id}`))
                .expect(409);
        });
    });
});

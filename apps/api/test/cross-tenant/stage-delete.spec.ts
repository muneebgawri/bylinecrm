import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE, type DomainEvent } from '@bylinecrm/shared';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
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

interface Stage {
    id: string;
    name: string;
    position: number;
    kind: string;
}
interface Pipeline {
    id: string;
    name: string;
    stages: Stage[];
}
interface Deal {
    id: string;
    stageId: string;
    closedAt: string | null;
}
interface ErrorBody {
    code: string;
    fieldErrors?: { path: string }[];
    details?: Record<string, unknown>;
}

/**
 * Deleting a stage that still holds deals (#74): the deals — trashed ones included — move to an
 * open stage of the same pipeline through the one move service, one event and one history row per
 * deal, and the stage goes; without a target the refusal says how many deals are in the way.
 * Archived custom fields come back with restore.
 */
describe('FR-CRMS-9 deleting a stage by moving its deals', () => {
    let app: INestApplication;
    let http: () => request.Agent;
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const password = 'correct horse battery staple';
    let admin: Browser;
    let other: Browser;
    let rep: Browser;
    let workspace: string;
    let otherWorkspace: string;
    let otherPipeline: Pipeline;
    const events: DomainEvent[] = [];

    const as = (who: Browser) => ({
        get: (path: string) => http().get(path).set('Cookie', who.cookie),
        post: (path: string) => http().post(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
        delete: (path: string) => http().delete(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
    });
    const w = (path: string) => `/api/w/${workspace}${path}`;

    async function freshPipeline(name: string): Promise<Pipeline> {
        return (
            await as(admin)
                .post(w('/pipelines'))
                .send({ name: `${name} ${stamp}` })
                .expect(201)
        ).body as Pipeline;
    }
    async function deal(p: Pipeline, name: string, stageId: string): Promise<Deal> {
        return (await as(admin).post(w('/opportunities')).send({ name, pipelineId: p.id, stageId }).expect(201))
            .body as Deal;
    }
    const byName = (p: Pipeline, name: string) => p.stages.find((s) => s.name === name)!;

    beforeAll(async () => {
        app = await createApp();
        await app.init();
        http = () => request(app.getHttpServer());
        app.get(EventEmitter2).on('deal.*', (event: DomainEvent) => events.push(event));

        const signup = await http()
            .post('/api/auth/signup')
            .send({ email: `admin-${stamp}@example.test`, password, workspaceName: 'Stage Co' })
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
        otherPipeline = (
            (await as(other).get(`/api/w/${otherWorkspace}/pipelines`).expect(200)).body as Pipeline[]
        )[0]!;

        // An own-scoped member who can nevertheless configure pipelines: the operation must refuse
        // them, because their view of the stage's deals is only their own.
        const role = await as(admin)
            .post(w('/roles'))
            .send({
                name: 'scoped configurer',
                capabilities: ['record:read', 'deal:read', 'pipeline:configure'],
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
    });

    afterAll(async () => {
        await app.close();
    });

    it('refuses without a target and names the live and trashed deals in the way', async () => {
        const p = await freshPipeline('Refuse');
        const contacted = byName(p, 'Contacted');
        await deal(p, 'Live one', contacted.id);
        await deal(p, 'Live two', contacted.id);
        const trashed = await deal(p, 'Trashed', contacted.id);
        await as(admin)
            .delete(w(`/opportunities/${trashed.id}`))
            .expect(204);

        const res = await as(admin)
            .delete(w(`/pipelines/${p.id}/stages/${contacted.id}`))
            .expect(409);
        const body = res.body as ErrorBody;
        expect(body.code).toBe('conflict');
        expect(body.details).toEqual({ liveDeals: 2, trashedDeals: 1 });
    });

    it('moves every deal, trashed included, then deletes the stage and closes the gap', async () => {
        const p = await freshPipeline('Move');
        const contacted = byName(p, 'Contacted');
        const target = byName(p, 'New');
        const live = await deal(p, 'Mover', contacted.id);
        const trashed = await deal(p, 'Trashed mover', contacted.id);
        await as(admin)
            .delete(w(`/opportunities/${trashed.id}`))
            .expect(204);
        const before = events.length;

        await as(admin)
            .delete(w(`/pipelines/${p.id}/stages/${contacted.id}?moveDealsTo=${target.id}`))
            .expect(204);

        const after = (
            await as(admin)
                .get(w(`/pipelines/${p.id}`))
                .expect(200)
        ).body as Pipeline;
        expect(after.stages.map((s) => s.name)).not.toContain('Contacted');
        expect(after.stages.map((s) => s.position)).toEqual(after.stages.map((_, i) => i + 1));

        // One event per deal, each the open-stage move, attributed to the admin.
        const moved = events.slice(before).filter((e) => e.type === 'deal.stage_changed');
        expect(moved.map((e) => e.recordId).sort()).toEqual([live.id, trashed.id].sort());
        expect(events.slice(before).filter((e) => e.type !== 'deal.stage_changed')).toEqual([]);
        for (const e of moved) {
            expect(e.actor.kind).toBe('member');
            expect((e as { stage?: { reason?: string } }).stage?.reason).toBe('stage_deleted');
        }

        // The live deal sits in the target with a history row and one timeline entry for the move.
        const history = (
            await as(admin)
                .get(w(`/opportunities/${live.id}/history`))
                .expect(200)
        ).body as {
            fromStageId: string | null;
            toStageId: string;
            reason: string;
        }[];
        expect(history[0]).toMatchObject({
            fromStageId: contacted.id,
            fromStageName: 'Contacted',
            toStageId: target.id,
            toStageName: 'New',
            reason: 'stage_deleted',
        });
        const timeline = (
            await as(admin)
                .get(w(`/timeline?target=opportunity:${live.id}&kinds=deal.stage_changed`))
                .expect(200)
        ).body as { items: unknown[] };
        expect(timeline.items).toHaveLength(1);

        // The trashed deal moved too and is still in the trash, restorable into the target stage.
        await as(admin)
            .post(w(`/opportunities/${trashed.id}/restore`))
            .expect(201);
        const restored = (
            await as(admin)
                .get(w(`/opportunities/${trashed.id}`))
                .expect(200)
        ).body as Deal;
        expect(restored.stageId).toBe(target.id);
    });

    it('deletes an empty stage that once held deals, and history still names it', async () => {
        const p = await freshPipeline('Once held');
        const contacted = byName(p, 'Contacted');
        const replied = byName(p, 'Replied');
        const passer = await deal(p, 'Passed through', contacted.id);
        await as(admin)
            .post(w(`/opportunities/${passer.id}/move`))
            .send({ stageId: replied.id })
            .expect(201);
        await as(admin)
            .delete(w(`/pipelines/${p.id}/stages/${contacted.id}`))
            .expect(204);
        const history = (
            await as(admin)
                .get(w(`/opportunities/${passer.id}/history`))
                .expect(200)
        ).body as {
            fromStageId: string | null;
            fromStageName: string | null;
            toStageId: string;
            toStageName: string;
        }[];
        expect(history.map((h) => [h.fromStageName, h.toStageName])).toEqual([
            ['Contacted', 'Replied'],
            [null, 'Contacted'],
        ]);
        expect(history[0]?.fromStageId).toBe(contacted.id);
    });

    it('reopens deals of a deleted closed stage: the target is open, so the close is cleared', async () => {
        const p = await freshPipeline('Reopen');
        const won = byName(p, 'Won');
        const target = byName(p, 'Meeting');
        const closed = await deal(p, 'Was won', byName(p, 'New').id);
        await as(admin)
            .post(w(`/opportunities/${closed.id}/move`))
            .send({ stageId: won.id, close: {} })
            .expect(201);
        await as(admin)
            .delete(w(`/pipelines/${p.id}/stages/${won.id}?moveDealsTo=${target.id}`))
            .expect(204);
        const reopened = (
            await as(admin)
                .get(w(`/opportunities/${closed.id}`))
                .expect(200)
        ).body as Deal;
        expect(reopened).toMatchObject({ stageId: target.id, closedAt: null });
    });

    it('refuses a won or lost target, naming the field', async () => {
        const p = await freshPipeline('Closed target');
        const contacted = byName(p, 'Contacted');
        await deal(p, 'Stays', contacted.id);
        for (const name of ['Won', 'Lost']) {
            const res = await as(admin)
                .delete(w(`/pipelines/${p.id}/stages/${contacted.id}?moveDealsTo=${byName(p, name).id}`))
                .expect(400);
            const body = res.body as ErrorBody;
            expect(body.code).toBe('validation.failed');
            expect(body.fieldErrors?.map((f) => f.path)).toEqual(['moveDealsTo']);
        }
    });

    it('refuses another pipeline’s stage and another workspace’s stage as the target', async () => {
        const p = await freshPipeline('Foreign target');
        const elsewhere = await freshPipeline('Elsewhere');
        const contacted = byName(p, 'Contacted');
        await deal(p, 'Stays put', contacted.id);
        await as(admin)
            .delete(w(`/pipelines/${p.id}/stages/${contacted.id}?moveDealsTo=${byName(elsewhere, 'New').id}`))
            .expect(404);
        await as(admin)
            .delete(w(`/pipelines/${p.id}/stages/${contacted.id}?moveDealsTo=${otherPipeline.stages[0]!.id}`))
            .expect(404);
    });

    it('keeps another workspace’s stage out of reach entirely', async () => {
        await as(admin)
            .delete(w(`/pipelines/${otherPipeline.id}/stages/${otherPipeline.stages[1]!.id}`))
            .expect(404);
        await as(other)
            .delete(`/api/w/${workspace}/pipelines/${otherPipeline.id}/stages/${otherPipeline.stages[1]!.id}`)
            .expect(403);
    });

    it('refuses an own-scoped configurer: a delete moves every deal, not only theirs', async () => {
        const p = await freshPipeline('Scoped');
        const res = await as(rep)
            .delete(w(`/pipelines/${p.id}/stages/${byName(p, 'Contacted').id}?moveDealsTo=${byName(p, 'New').id}`))
            .expect(403);
        expect((res.body as ErrorBody).code).toBe('forbidden');
    });
});

describe('restoring an archived custom field', () => {
    let app: INestApplication;
    let http: () => request.Agent;
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const password = 'correct horse battery staple';
    let admin: Browser;
    let other: Browser;
    let workspace: string;
    let otherWorkspace: string;

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
        const signup = await http()
            .post('/api/auth/signup')
            .send({ email: `fields-${stamp}@example.test`, password, workspaceName: 'Fields Co' })
            .expect(201);
        await verifyAddress(app, http, `fields-${stamp}@example.test`);
        admin = browserFrom(signup);
        workspace = (signup.body as { workspace: { id: string } }).workspace.id;
        const otherSignup = await http()
            .post('/api/auth/signup')
            .send({ email: `fields-other-${stamp}@example.test`, password, workspaceName: 'Other Fields Co' })
            .expect(201);
        await verifyAddress(app, http, `fields-other-${stamp}@example.test`);
        other = browserFrom(otherSignup);
        otherWorkspace = (otherSignup.body as { workspace: { id: string } }).workspace.id;
    });

    afterAll(async () => {
        await app.close();
    });

    it('un-archives a definition: the key is accepted on records again', async () => {
        const field = (
            await as(admin)
                .post(w('/custom-fields'))
                .send({ object: 'person', key: 'beat', label: 'Beat', type: 'text' })
                .expect(201)
        ).body as { id: string };
        await as(admin)
            .delete(w(`/custom-fields/${field.id}`))
            .expect(204);
        await as(admin)
            .post(w('/people'))
            .send({ nameFirst: 'Before', custom: { beat: 'Fintech' } })
            .expect(400);

        const restored = (
            await as(admin)
                .post(w(`/custom-fields/${field.id}/restore`))
                .expect(201)
        ).body as {
            id: string;
            archivedAt: string | null;
        };
        expect(restored).toMatchObject({ id: field.id, archivedAt: null });
        await as(admin)
            .post(w('/people'))
            .send({ nameFirst: 'After', custom: { beat: 'Fintech' } })
            .expect(201);
        // Restoring an active definition changes nothing.
        await as(admin)
            .post(w(`/custom-fields/${field.id}/restore`))
            .expect(201);
    });

    it('cannot collide: an archived key still holds its place, so a new field may not take it', async () => {
        const field = (
            await as(admin)
                .post(w('/custom-fields'))
                .send({ object: 'company', key: 'tier', label: 'Tier', type: 'text' })
                .expect(201)
        ).body as { id: string };
        await as(admin)
            .delete(w(`/custom-fields/${field.id}`))
            .expect(204);
        const res = await as(admin)
            .post(w('/custom-fields'))
            .send({ object: 'company', key: 'tier', label: 'Tier again', type: 'text' })
            .expect(409);
        expect((res.body as ErrorBody).code).toBe('conflict.unique');
    });

    it('is another workspace’s field to nobody else', async () => {
        const field = (
            await as(admin)
                .post(w('/custom-fields'))
                .send({ object: 'person', key: 'region', label: 'Region', type: 'text' })
                .expect(201)
        ).body as { id: string };
        await as(admin)
            .delete(w(`/custom-fields/${field.id}`))
            .expect(204);
        await as(other).post(`/api/w/${otherWorkspace}/custom-fields/${field.id}/restore`).expect(404);
    });
});

import 'reflect-metadata';
import { type INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import {
    CSRF_COOKIE,
    CSRF_HEADER,
    SESSION_COOKIE,
    type NotificationsView,
    type RotationMemberView,
    type RotationPreviewView,
    type RotationSettingsView,
    type TransferView,
} from '@bylinecrm/shared';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_OPTIONS, configureApp } from '../../src/app';
import { AppModule } from '../../src/app.module';
import { CadenceService } from '../../src/cadence/cadence.service';
import { RotationService } from '../../src/cadence/rotation.service';
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
type Deal = { id: string; ownerId: string | null; cadenceDueAt: string | null; cadenceOverdue: boolean };
const DAY = 24 * 60 * 60 * 1000;
const SETTINGS = {
    enabled: false,
    warnAfterDays: 0,
    graceDays: 7,
    intakeEnabled: false,
    mailboxPreference: 'prefer',
    openLeadCap: null,
};

/**
 * CADENCE-1: a cadence per stage, one warning per lapse, a rotation seven days later through a forced transfer, the
 * exclusions, pauses, the switch-on grace, the round-robin pointer under concurrency, and each workspace's rotation
 * its own.
 */
describe('CADENCE-1 cadence and round-robin rotation', () => {
    let app: INestApplication;
    let http: () => request.Agent;
    let owner: PrismaService;
    let rls: RlsPrismaService;
    let cadence: CadenceService;
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const password = 'correct horse battery staple';
    let a: { who: Who; id: string };
    let b: { who: Who; id: string };
    let ana: Who;
    let mia: Who;
    const ids: Record<'admin' | 'ana' | 'ben' | 'mia', string> = { admin: '', ana: '', ben: '', mia: '' };

    const as = (who: Who) => ({
        get: (path: string) => http().get(path).set('Cookie', who.cookie),
        post: (path: string) => http().post(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
        put: (path: string) => http().put(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
        patch: (path: string) => http().patch(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
    });
    const w = (path: string, ws = a.id) => `/api/w/${ws}${path}`;

    /** A company, its contact and an open deal of Ana's; `ageDays` makes every touch that old. */
    const lead = async (name: string, ageDays: number) => {
        const domain = `${name.toLowerCase()}-${stamp}.test`;
        const company = (await as(ana).post(w('/companies')).send({ name, domain }).expect(201)).body as { id: string };
        const person = (
            await as(ana)
                .post(w('/people'))
                .send({ nameFirst: name, companyId: company.id, emails: { primary: `lead@${domain}`, additional: [] } })
                .expect(201)
        ).body as { id: string };
        const deal = (
            await as(ana)
                .post(w('/opportunities'))
                .send({ name: `${name} deal`, companyId: company.id, pointOfContactId: person.id })
                .expect(201)
        ).body as Deal;
        await settle(app);
        await owner.$executeRaw`UPDATE "opportunities" SET "created_at" = now() - make_interval(days => ${ageDays}::int) WHERE "id" = ${deal.id}::uuid`;
        await owner.$executeRaw`UPDATE "opportunity_stage_history" SET "entered_at" = now() - make_interval(days => ${ageDays}::int) WHERE "opportunity_id" = ${deal.id}::uuid`;
        return { deal: deal.id, person: person.id, domain };
    };
    const deal = async (id: string) =>
        (
            await as(a.who)
                .get(w(`/opportunities/${id}`))
                .expect(200)
        ).body as Deal;
    const settings = (input: Partial<typeof SETTINGS>, who = a.who, ws = a.id) =>
        as(who)
            .put(w('/rotation/settings', ws))
            .send({ ...SETTINGS, ...input })
            .expect(200)
            .then((r) => r.body as RotationSettingsView);
    const kinds = async (who: Who) =>
        ((await as(who).get(w('/notifications')).expect(200)).body as NotificationsView).items.map((i) => i.kind);

    beforeAll(async () => {
        const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
        app = configureApp(moduleRef.createNestApplication<NestExpressApplication>(APP_OPTIONS));
        await app.init();
        http = () => request(app.getHttpServer() as Parameters<typeof request>[0]);
        owner = app.get(PrismaService);
        rls = app.get(RlsPrismaService);
        cadence = app.get(CadenceService);
        const signUp = async (email: string) => {
            const res = await http().post('/api/auth/signup').send({ email, password, workspaceName: email });
            expect(res.status).toBe(201);
            await verifyAddress(app, http, email);
            return { who: browserFrom(res), id: (res.body as { workspace: { id: string } }).workspace.id };
        };
        a = await signUp(`cadence-a-${stamp}@example.test`);
        b = await signUp(`cadence-b-${stamp}@example.test`);

        const roles = (await as(a.who).get(w('/roles')).expect(200)).body as { id: string; name: string }[];
        const am = (
            await as(a.who)
                .post(w('/roles'))
                .send({
                    name: 'account manager',
                    recordScope: 'all',
                    capabilities: ['record:read', 'record:write', 'deal:read', 'deal:edit', 'deal:move', 'note:write'],
                })
                .expect(201)
        ).body as { id: string };
        const join = async (email: string, roleId: string) => {
            const invite = await as(a.who).post(w('/invites')).send({ email, roleId }).expect(201);
            const joined = await http()
                .post(`/api/auth/invites/${(invite.body as { token: string }).token}/signup`)
                .send({ password })
                .expect(201);
            await verifyAddress(app, http, email);
            return browserFrom(joined);
        };
        ana = await join(`cadence-ana-${stamp}@example.test`, am.id);
        await join(`cadence-ben-${stamp}@example.test`, am.id);
        mia = await join(`cadence-mia-${stamp}@example.test`, roles.find((r) => r.name === 'manager')!.id);
        const members = (await as(a.who).get(w('/members')).expect(200)).body as { id: string; email: string }[];
        for (const key of ['ana', 'ben', 'mia'] as const) {
            ids[key] = members.find((m) => m.email === `cadence-${key}-${stamp}@example.test`)!.id;
        }
        ids.admin = members.find((m) => m.email === `cadence-a-${stamp}@example.test`)!.id;
    });

    afterAll(async () => {
        await app?.close();
    });

    it('gives each open stage its default cadence and none to a closed one; a manager edits them', async () => {
        const pipeline = (
            (await as(a.who).get(w('/pipelines')).expect(200)).body as {
                id: string;
                stages: { id: string; name: string; kind: string; cadenceDays: number | null }[];
            }[]
        )[0]!;
        expect(pipeline.stages.find((s) => s.name === 'New')!.cadenceDays).toBe(1);
        expect(pipeline.stages.filter((s) => s.kind !== 'open').every((s) => s.cadenceDays === null)).toBe(true);
        const meeting = pipeline.stages.find((s) => s.name === 'Meeting')!;
        await as(ana)
            .put(w(`/pipelines/${pipeline.id}/cadence`))
            .send({ stages: [{ stageId: meeting.id, cadenceDays: 4 }] })
            .expect(403);
        const won = pipeline.stages.find((s) => s.kind === 'won')!;
        await as(mia)
            .put(w(`/pipelines/${pipeline.id}/cadence`))
            .send({ stages: [{ stageId: won.id, cadenceDays: 2 }] })
            .expect(400);
        const edited = await as(mia)
            .put(w(`/pipelines/${pipeline.id}/cadence`))
            .send({ stages: [{ stageId: meeting.id, cadenceDays: 4 }] })
            .expect(200);
        expect((edited.body as typeof pipeline).stages.find((s) => s.id === meeting.id)!.cadenceDays).toBe(4);
    });

    it('a fresh deal is due a day after its last touch, and is not overdue', async () => {
        const fresh = await lead('Fresh', 0);
        await cadence.runWorkspace(a.id);
        const view = await deal(fresh.deal);
        expect(view.cadenceOverdue).toBe(false);
        expect(Math.abs(new Date(view.cadenceDueAt!).getTime() - (Date.now() + DAY))).toBeLessThan(60_000);
    });

    describe('warn, then rotate', () => {
        let stale: { deal: string; person: string };
        let enabledAt: Date;

        it('with rotation off: overdue is flagged and previewed, nothing is warned', async () => {
            stale = await lead('Stale', 10);
            const result = await cadence.runWorkspace(a.id);
            expect(result).toEqual({ warned: 0, rotated: 0 });
            expect((await deal(stale.deal)).cadenceOverdue).toBe(true);
            const person = (
                await as(a.who)
                    .get(w(`/people/${stale.person}`))
                    .expect(200)
            ).body as {
                cadenceOverdue: boolean;
            };
            expect(person.cadenceOverdue).toBe(true);
            const preview = (await as(mia).get(w('/rotation/preview')).expect(200)).body as RotationPreviewView;
            const item = preview.items.find((i) => i.opportunityId === stale.deal)!;
            expect(item).toMatchObject({ action: 'warn', owner: { memberId: ids.ana } });
            // Measured from the switch-on, not the ten-day-old due date: it would rotate a grace from now.
            expect(new Date(item.rotateAt).getTime()).toBeGreaterThan(Date.now() + 6 * DAY);
            expect(await owner.cadenceLapse.count({ where: { workspaceId: a.id } })).toBe(0);
            await as(ana).get(w('/rotation/preview')).expect(403);
        });

        it('switched on, the backlog is warned from now — once — and never rotated at once', async () => {
            const view = await settings({ enabled: true });
            enabledAt = new Date(view.enabledAt!);
            const first = await cadence.runWorkspace(a.id);
            expect(first.rotated).toBe(0);
            expect(first.warned).toBeGreaterThanOrEqual(1);
            expect(await cadence.runWorkspace(a.id)).toEqual({ warned: 0, rotated: 0 });
            expect((await kinds(ana)).filter((k) => k === 'cadence_warning').length).toBe(first.warned);
            expect((await cadence.runWorkspace(a.id, new Date(enabledAt.getTime() + 3 * DAY))).rotated).toBe(0);
            expect((await deal(stale.deal)).ownerId).toBe(ids.ana);
        });

        it('seven days after the warning, untouched, it rotates to the next rep — once', async () => {
            const later = new Date(enabledAt.getTime() + 8 * DAY);
            const run = await cadence.runWorkspace(a.id, later);
            expect(run.rotated).toBeGreaterThanOrEqual(1);
            expect((await cadence.runWorkspace(a.id, later)).rotated).toBe(0);
            const moved = await deal(stale.deal);
            // Ben: the only rep left once Ana is excluded (admins and managers are out by default).
            expect(moved.ownerId).toBe(ids.ben);
            expect(moved.cadenceOverdue).toBe(false);
            const transfers = (
                await as(a.who)
                    .get(w(`/transfers?object=person&recordId=${stale.person}`))
                    .expect(200)
            ).body as TransferView[];
            expect(transfers[0]).toMatchObject({ status: 'forced', reason: 'cadence_rotation' });
            expect(transfers[0]!.note).toContain('No qualifying touch since');
            expect(await kinds(ana)).toContain('transfer_taken');
            expect(await kinds(mia)).toContain('cadence_rotated');
            const lapse = await owner.cadenceLapse.findFirstOrThrow({ where: { opportunityId: stale.deal } });
            expect(lapse).toMatchObject({ resolution: 'rotated', transferId: transfers[0]!.id });
        });
    });

    it('a touch ends the lapse: a note on the deal before the grace runs out keeps it with its owner', async () => {
        const touched = await lead('Touched', 10);
        await cadence.runWorkspace(a.id);
        expect(await owner.cadenceLapse.count({ where: { opportunityId: touched.deal, resolvedAt: null } })).toBe(1);
        await as(ana)
            .post(w('/notes'))
            .send({ title: 'Called them', targets: [{ type: 'opportunity', id: touched.deal }] })
            .expect(201);
        await settle(app);
        const lapse = await owner.cadenceLapse.findFirstOrThrow({ where: { opportunityId: touched.deal } });
        expect(lapse.resolution).toBe('touched');
        await cadence.runWorkspace(a.id, new Date(Date.now() + 8 * DAY));
        expect((await deal(touched.deal)).ownerId).toBe(ids.ana);
    });

    it('never applies to an excluded or suppressed contact, nor to a customer', async () => {
        const excluded = await lead('Excluded', 10);
        await owner.outreachExclusion.create({
            data: { workspaceId: a.id, domain: excluded.domain, reason: 'account_managed', source: 'manual' },
        });
        const customer = await lead('Customer', 10);
        const stages = (
            (await as(a.who).get(w('/pipelines')).expect(200)).body as {
                stages: { id: string; kind: string }[];
            }[]
        )[0]!.stages;
        const other = (
            await as(ana)
                .post(w('/opportunities'))
                .send({ name: 'Won one', pointOfContactId: customer.person })
                .expect(201)
        ).body as { id: string };
        await as(a.who)
            .post(w(`/opportunities/${other.id}/move`))
            .send({ stageId: stages.find((s) => s.kind === 'won')!.id, close: {} })
            .expect(201);
        await settle(app);
        await cadence.runWorkspace(a.id);
        for (const id of [excluded.deal, customer.deal]) {
            expect(await deal(id)).toMatchObject({ cadenceDueAt: null, cadenceOverdue: false });
            expect(await owner.cadenceLapse.count({ where: { opportunityId: id } })).toBe(0);
        }
    });

    it('a paused rep is not dealt to; with nobody else eligible the lapse waits, and goes once they are back', async () => {
        const waiting = await lead('Waiting', 10);
        await cadence.runWorkspace(a.id);
        const paused = await as(mia)
            .patch(w(`/rotation/members/${ids.ben}`))
            .send({ resumeAt: new Date(Date.now() + 30 * DAY).toISOString() })
            .expect(200);
        expect(paused.body as RotationMemberView).toMatchObject({ paused: true, eligible: false });
        await as(ana)
            .patch(w(`/rotation/members/${ids.ben}`))
            .send({ paused: false })
            .expect(403);
        const later = new Date(Date.now() + 8 * DAY);
        await cadence.runWorkspace(a.id, later);
        expect((await deal(waiting.deal)).ownerId).toBe(ids.ana);
        expect(
            (await owner.cadenceLapse.findFirstOrThrow({ where: { opportunityId: waiting.deal } })).blockedReason,
        ).toBe('no_eligible_member');
        await as(mia)
            .patch(w(`/rotation/members/${ids.ben}`))
            .send({ paused: false })
            .expect(200);
        await cadence.runWorkspace(a.id, later);
        expect((await deal(waiting.deal)).ownerId).toBe(ids.ben);
    });

    it('deals in turn under concurrency: the pointer is taken under a row lock', async () => {
        const rotation = app.get(RotationService);
        await as(mia)
            .patch(w(`/rotation/members/${ids.mia}`))
            .send({ included: true })
            .expect(200);
        const before = (await owner.rotationSettings.findUniqueOrThrow({ where: { workspaceId: a.id } })).cursor;
        const dealt = await Promise.all(
            Array.from({ length: 12 }, () => rls.withWorkspace(a.id, (tx) => rotation.deal(tx, a.id))),
        );
        const count = (id: string) => dealt.filter((d) => d === id).length;
        expect(count(ids.ana) + count(ids.ben) + count(ids.mia)).toBe(12);
        expect([count(ids.ana), count(ids.ben), count(ids.mia)]).toEqual([4, 4, 4]);
        expect((await owner.rotationSettings.findUniqueOrThrow({ where: { workspaceId: a.id } })).cursor).toBe(
            before + 12,
        );
    });

    it('intake: a deal saved without an owner by an API key goes to the next rep, when intake is on', async () => {
        await settings({ enabled: true, intakeEnabled: true });
        const roles = (await as(a.who).get(w('/roles')).expect(200)).body as { id: string; name: string }[];
        const adminRole = roles.find((r) => r.name === 'admin')!.id;
        const key = (
            await as(a.who)
                .post(w('/api-keys'))
                .send({ name: `intake ${stamp}`, roleId: adminRole })
                .expect(201)
        ).body as { secret: string };
        const res = await http()
            .post(w('/people'))
            .set('Authorization', `Bearer ${key.secret}`)
            .send({ nameFirst: 'Inbound', emails: { primary: `inbound-${stamp}@gmail.com`, additional: [] } })
            .expect(201);
        expect([ids.ana, ids.ben, ids.mia]).toContain((res.body as { ownerId: string | null }).ownerId);
    });

    describe('each workspace’s rotation its own', () => {
        it('settings, members and the preview read only the caller’s workspace', async () => {
            expect((await as(b.who).get(w('/rotation/settings', b.id)).expect(200)).body).toMatchObject({
                enabled: false,
                enabledAt: null,
            });
            const members = (await as(b.who).get(w('/rotation/members', b.id)).expect(200))
                .body as RotationMemberView[];
            expect(members.map((m) => m.memberId)).not.toContain(ids.ana);
            await as(b.who)
                .patch(w(`/rotation/members/${ids.ana}`, b.id))
                .send({ paused: true })
                .expect(404);
            const preview = (await as(b.who).get(w('/rotation/preview', b.id)).expect(200)).body as RotationPreviewView;
            expect(preview.items).toEqual([]);
            await as(b.who).get(w('/rotation/settings')).expect(403);
        });

        it('the new tables are invisible and unwritable from another workspace’s scope', async () => {
            const seen = await rls.withWorkspace(b.id, async (tx) => ({
                settings: await tx.rotationSettings.findMany(),
                members: await tx.rotationMember.findMany(),
                lapses: await tx.cadenceLapse.findMany(),
            }));
            expect(seen.settings.map((s) => s.workspaceId)).not.toContain(a.id);
            expect(seen.members.map((m) => m.workspaceId)).not.toContain(a.id);
            expect(seen.lapses.map((l) => l.workspaceId)).not.toContain(a.id);
            const changed = await rls.withWorkspace(b.id, (tx) =>
                tx.rotationSettings.updateMany({ where: { workspaceId: a.id }, data: { cursor: 0 } }),
            );
            expect(changed.count).toBe(0);
            await expect(
                rls.withWorkspace(b.id, (tx) =>
                    tx.rotationMember.create({ data: { workspaceId: a.id, memberId: ids.ana } }),
                ),
            ).rejects.toThrow();
        });
    });
});

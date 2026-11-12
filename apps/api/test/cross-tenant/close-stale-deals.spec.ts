import 'reflect-metadata';
import { type INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE } from '@bylinecrm/shared';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_OPTIONS, configureApp } from '../../src/app';
import { AppModule } from '../../src/app.module';
import { closeStaleDeals, parseArgs, STALE_LOST_REASON_CODE, staleLostReason } from '../../src/cli/close-stale-deals';
import { PrismaService } from '../../src/infra/prisma.service';
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

const MONTHS = 12;
const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000);
const OLD = daysAgo(400);
const RECENT = daysAgo(30);

/**
 * `close-stale-deals.js`: the Bigin backlog. An imported deal with no activity for a year is closed as lost by the
 * system; one with a recent email, note, call or stage move stays, and so does every deal the import did not bring.
 */
describe('close-stale-deals: imported deals idle a year are closed as lost', () => {
    let app: INestApplication;
    let http: () => request.Agent;
    let owner: PrismaService;
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const password = 'correct horse battery staple';
    let admin: Browser;
    let workspace: string;
    let person: string;
    /** Imported, created long ago, nothing since: closed. */
    let silent: string;
    /** Imported and old, but Bigin saw it modified recently: kept. */
    let touchedInBigin: string;
    /** Imported and old, but its contact got an email recently: kept. */
    let contactMailed: string;
    /** Imported and old, with only an import's bookkeeping since: closed. */
    let bookkept: string;
    /** Old, but not the import's: kept. */
    let native: string;
    /** An open task on the silent deal alone: done with it. */
    let taskOnSilent: string;
    /** An open task on the silent deal and on the Bigin-touched one, which stays open: kept. */
    let taskOnBoth: string;
    /** An open task on the kept deal: kept. */
    let taskOnKept: string;

    const as = (who: Browser) => ({
        get: (path: string) => http().get(path).set('Cookie', who.cookie),
        post: (path: string) => http().post(path).set('Cookie', who.cookie).set(CSRF_HEADER, who.csrf),
    });
    const w = (path: string) => `/api/w/${workspace}${path}`;
    const id = (res: Response) => (res.body as { id: string }).id;
    const deal = async (dealId: string) =>
        owner.opportunity.findUniqueOrThrow({
            where: { id: dealId },
            select: { closedAt: true, lostReason: true, lostReasonCode: true, stage: { select: { kind: true } } },
        });

    beforeAll(async () => {
        const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
        app = configureApp(moduleRef.createNestApplication<NestExpressApplication>(APP_OPTIONS));
        await app.init();
        http = () => request(app.getHttpServer() as Parameters<typeof request>[0]);
        owner = app.get(PrismaService);

        const adminEmail = `csd-admin-${stamp}@example.test`;
        const res = await http()
            .post('/api/auth/signup')
            .send({ email: adminEmail, password, workspaceName: `Csd ${stamp}` });
        expect(res.status).toBe(201);
        await verifyAddress(app, http, adminEmail);
        admin = browserFrom(res);
        workspace = (res.body as { workspace: { id: string } }).workspace.id;

        const company = id(
            await as(admin)
                .post(w('/companies'))
                .send({ name: `Acme ${stamp}`, domain: `acme-${stamp}.test` })
                .expect(201),
        );
        person = id(
            await as(admin)
                .post(w('/people'))
                .send({
                    nameFirst: 'Lead',
                    emails: { primary: `lead@${stamp}.test`, additional: [] },
                    companyId: company,
                })
                .expect(201),
        );
        const makeDeal = async (name: string, imported: { modifiedAt: Date | null } | null) => {
            const made = id(
                await as(admin)
                    .post(w('/opportunities'))
                    .send({ name: `${name} ${stamp}`, currency: 'USD', pointOfContactId: person, companyId: company })
                    .expect(201),
            );
            // As the migration left them: created long ago, placed by the import, bookkeeping entries since.
            await owner.opportunity.update({ where: { id: made }, data: { createdAt: OLD } });
            await owner.opportunityStageHistory.updateMany({
                where: { opportunityId: made },
                data: { reason: 'import', actor: { kind: 'import', id: null }, enteredAt: RECENT },
            });
            await owner.timelineActivity.updateMany({
                where: { targetType: 'opportunity', targetId: made },
                data: { happenedAt: RECENT, actor: { kind: 'import', id: null } },
            });
            if (imported) {
                await owner.biginImportLink.create({
                    data: {
                        workspaceId: workspace,
                        object: 'Deals',
                        externalId: `zcrm_${name}_${stamp}`,
                        localType: 'opportunity',
                        localId: made,
                        externalUpdatedAt: imported.modifiedAt,
                    },
                });
            }
            return made;
        };
        silent = await makeDeal('silent', { modifiedAt: OLD });
        touchedInBigin = await makeDeal('touched', { modifiedAt: RECENT });
        contactMailed = await makeDeal('mailed', { modifiedAt: OLD });
        bookkept = await makeDeal('bookkept', { modifiedAt: null });
        native = await makeDeal('native', null);
        // The person's timeline: `person.updated` from the recount is bookkeeping; a received email is activity —
        // but only `contactMailed`'s contact got it, so the contact is a second person for that deal.
        const mailed = id(
            await as(admin)
                .post(w('/people'))
                .send({
                    nameFirst: 'Replied',
                    emails: { primary: `replied@${stamp}.test`, additional: [] },
                    companyId: company,
                })
                .expect(201),
        );
        await owner.opportunity.update({ where: { id: contactMailed }, data: { pointOfContactId: mailed } });
        await owner.timelineActivity.updateMany({
            where: { targetType: 'person', targetId: { in: [person, mailed] } },
            data: { happenedAt: RECENT, kind: 'person.updated', actor: { kind: 'import', id: null } },
        });
        await owner.timelineActivity.create({
            data: {
                workspaceId: workspace,
                targetType: 'person',
                targetId: mailed,
                kind: 'linked-email.received',
                happenedAt: RECENT,
                actor: { kind: 'system', id: null },
            },
        });
        const task = async (title: string, deals: string[]) =>
            id(
                await as(admin)
                    .post(w('/tasks'))
                    .send({ title, targets: deals.map((dealId) => ({ type: 'opportunity', id: dealId })) })
                    .expect(201),
            );
        taskOnSilent = await task('Call back', [silent]);
        taskOnBoth = await task('Send deck', [silent, touchedInBigin]);
        taskOnKept = await task('Follow up', [touchedInBigin]);
        // The tasks' own timeline entries are the import's shape too: bookkeeping, not activity.
        await owner.timelineActivity.updateMany({
            where: { kind: { startsWith: 'linked-task.' } },
            data: { kind: 'linked-task.imported', happenedAt: OLD },
        });
        await owner.timelineActivity.create({
            data: {
                workspaceId: workspace,
                targetType: 'opportunity',
                targetId: bookkept,
                kind: 'opportunity.updated',
                happenedAt: RECENT,
                actor: { kind: 'system', id: null },
            },
        });
    });

    afterAll(async () => {
        await app?.close();
    });

    it('reads its flags: a mode, a cut-off in months and a chunk size, nothing else', () => {
        expect(parseArgs(['ws', '--estimate'])).toEqual({ slug: 'ws', options: { apply: false } });
        expect(parseArgs(['ws', '--apply', '--months', '18', '--chunk', '5'])).toEqual({
            slug: 'ws',
            options: { apply: true, months: 18, chunk: 5 },
        });
        for (const bad of [
            [],
            ['--apply'],
            ['ws'],
            ['ws', '--apply', '--estimate'],
            ['ws', '--apply', '--months', '0'],
            ['ws', '--apply', '--x'],
        ]) {
            expect(parseArgs(bad), bad.join(' ')).toBeNull();
        }
    });

    it('estimates the idle imported deals, changing nothing', async () => {
        expect(await closeStaleDeals(app, workspace, { apply: false, months: MONTHS })).toEqual({
            stale: 2,
            closed: 0,
            skipped: 0,
            tasksDone: 0,
        });
        // A longer cut-off than the deals' age: nothing is idle. A bad one is refused before any read.
        expect((await closeStaleDeals(app, workspace, { apply: false, months: 24 })).stale).toBe(0);
        await expect(closeStaleDeals(app, workspace, { apply: false, months: 0 })).rejects.toThrow('months');
        await expect(closeStaleDeals(app, workspace, { apply: true, chunk: 0 })).rejects.toThrow('chunk');
        expect((await deal(silent)).closedAt).toBeNull();
    });

    it('closes them as lost, no response, by the system, and leaves the rest; a rerun closes nothing more', async () => {
        // A chunk of one: the close is the same written chunk by chunk.
        expect(await closeStaleDeals(app, workspace, { apply: true, months: MONTHS, chunk: 1 })).toEqual({
            stale: 2,
            closed: 2,
            skipped: 0,
            tasksDone: 1,
        });
        const taskRow = (taskId: string) =>
            owner.task.findUniqueOrThrow({ where: { id: taskId }, select: { status: true, completedAt: true } });
        expect((await taskRow(taskOnSilent)).status).toBe('done');
        expect((await taskRow(taskOnSilent)).completedAt).not.toBeNull();
        expect((await taskRow(taskOnBoth)).status, 'also on a deal still open').toBe('todo');
        expect((await taskRow(taskOnKept)).status).toBe('todo');
        const taskEvent = await owner.outboxEvent.findFirst({
            where: {
                workspaceId: workspace,
                type: 'task.updated',
                payload: { path: ['recordId'], equals: taskOnSilent },
            },
            select: { payload: true },
        });
        expect((taskEvent?.payload as { internal?: boolean; actor: unknown }).internal).toBe(true);
        expect((taskEvent?.payload as { actor: unknown }).actor).toEqual({ kind: 'system', id: null });
        for (const closed of [silent, bookkept]) {
            const row = await deal(closed);
            expect(row.stage.kind).toBe('lost');
            expect(row.closedAt).not.toBeNull();
            expect(row.lostReasonCode).toBe(STALE_LOST_REASON_CODE);
            expect(row.lostReason).toBe(staleLostReason(MONTHS));
            const history = await owner.opportunityStageHistory.findFirst({
                where: { opportunityId: closed, reason: 'close' },
                select: { actor: true, toStageName: true },
            });
            expect(history?.actor).toEqual({ kind: 'system', id: null });
            const event = await owner.outboxEvent.findFirst({
                where: { workspaceId: workspace, type: 'deal.lost', payload: { path: ['recordId'], equals: closed } },
                select: { payload: true },
            });
            expect((event?.payload as { internal?: boolean }).internal, 'kept off the webhooks').toBe(true);
        }
        for (const kept of [touchedInBigin, contactMailed, native]) {
            expect((await deal(kept)).closedAt, kept).toBeNull();
        }
        expect(await closeStaleDeals(app, workspace, { apply: true, months: MONTHS })).toEqual({
            stale: 0,
            closed: 0,
            skipped: 0,
            tasksDone: 0,
        });
    });
    it('--unowned closes an imported deal nobody owns and nobody could be given, whatever its source', async () => {
        const unowned = (apply: boolean) => closeStaleDeals(app, workspace, { apply, months: MONTHS, unowned: true });
        // `native` has no Bigin link: the other import's. Unowned, but its contact is a member's: theirs to be given.
        await owner.opportunity.update({
            where: { id: native },
            data: { ownerId: null, createdBy: { kind: 'import', id: null } },
        });
        expect((await unowned(false)).stale).toBe(0);
        await owner.opportunity.update({ where: { id: native }, data: { pointOfContactId: null } });
        expect((await unowned(false)).stale).toBe(1);
        expect(await unowned(true)).toMatchObject({ stale: 1, closed: 1, skipped: 0 });
        const closed = await owner.opportunity.findUniqueOrThrow({
            where: { id: native },
            select: { closedAt: true, lostReason: true, lostReasonCode: true },
        });
        expect(closed.closedAt).not.toBeNull();
        expect(closed).toMatchObject({ lostReason: staleLostReason(MONTHS, true), lostReasonCode: 'no_response' });
        expect((await unowned(true)).stale).toBe(0);
    });
});

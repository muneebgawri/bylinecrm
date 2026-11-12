import 'reflect-metadata';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { Actor } from '@bylinecrm/shared';
import { Prisma } from '@prisma/client';
import { AppModule } from '../app.module';
import { PrismaService } from '../infra/prisma.service';
import { RlsPrismaService, type WorkspaceClient } from '../infra/rls-prisma.service';
import type { WorkspaceRunContext } from '../infra/workspace-context';
import { StageMoveService } from '../pipelines/stage-move.service';
import { DomainEvents } from '../events/domain-events.service';
import { guardrailSettings, ownerlessMembers } from '../guardrails/guardrail-settings';
import { TasksService } from '../records/tasks.service';

const USAGE =
    'usage: node dist/cli/close-stale-deals.js <workspace-slug> --estimate|--apply [--unowned | --new-of <member-id,…> [--stage <name>]] [--months <n>] [--chunk <n>]';

/** Idle for this long and an imported deal is closed: the backlog cut-off the team agreed (2026-11-11). */
export const DEFAULT_IDLE_MONTHS = 12;

/**
 * Deals closed per transaction: each close is an update, a history row and an event, well inside the 15-second
 * transaction limit (`TRANSACTION_TIMEOUT_MS`). A chunk that fails leaves the ones before it committed; a rerun
 * continues from the deals still open.
 */
export const DEFAULT_CHUNK = 20;

/** The picklist reason the close records: nobody answered in a year. */
export const STALE_LOST_REASON_CODE = 'no_response' as const;

/** The free text beside it, naming the clean-up so a member reading the deal knows no one chose this by hand. */
export function staleLostReason(
    months: number,
    backlog: 'bigin' | 'unowned' | 'new' = 'bigin',
    stage?: string,
): string {
    const span = `${months} ${months === 1 ? 'month' : 'months'}`;
    if (backlog === 'unowned')
        return `Nobody’s deal, with no activity for ${span}: closed by the unowned-deal clean-up`;
    if (backlog === 'new' && stage)
        return `In ${stage} with no amount and no activity for ${span}: closed by the backlog clean-up`;
    if (backlog === 'new')
        return `Never worked: new, no amount, no activity for ${span}: closed by the backlog clean-up`;
    return `No activity for ${months} months: closed by the stale-deal clean-up`;
}

/**
 * The timeline entries that are activity on a deal or its contact — something a person did or said: mail either
 * way (synced, or carried over from Bigin as `external.email`), notes, tasks, calls, meetings, and what NewswireOS
 * reported (an order, a distribution). The rest of the timeline is bookkeeping — `opportunity.updated` and
 * `person.updated` from an import or a recount, stage rows an import wrote, owner fills — and the Bigin backlog
 * has a fresh one of those on every deal, so counting them would make nothing idle. An entry of these kinds that an
 * import wrote (a Bigin task carried over, dated the day it was imported) is bookkeeping too, and is not counted.
 */
export const ACTIVITY_KIND_PATTERNS: readonly string[] = [
    'linked-email.%',
    'external.email%',
    'linked-note.%',
    'linked-task.%',
    'linked-call.%',
    'linked-meeting.%',
    'external.newswireos_%',
];

export interface CloseStaleOptions {
    /** Write: without it, nothing changes and the counts say what `--apply` would do. */
    apply: boolean;
    /** Idle for at least this many whole months; `DEFAULT_IDLE_MONTHS` when absent. */
    months?: number | undefined;
    /** Deals closed per transaction; `DEFAULT_CHUNK` when absent. */
    chunk?: number | undefined;
    /**
     * The other backlog: imported deals from any source that nobody owns and nobody could be given — no owner, and
     * no contact an active member owns (`assign-deal-owners` gives the rest to their contact's owner).
     */
    unowned?: boolean | undefined;
    /**
     * A third backlog: the imported deals of these members (their ids) that were never worked — still in their
     * pipeline's first open stage, with no amount. What a member moved on, priced or touched stays.
     */
    newOf?: readonly string[] | undefined;
    /**
     * With `newOf`: the open stage to read instead of the first, by its name (any case) — those members' imported
     * deals left in it with no amount.
     */
    stage?: string | undefined;
    onProgress?: (line: string) => void;
}

export interface CloseStaleReport {
    /** Open imported deals idle past the cut-off: the deals closed (or that would be). */
    stale: number;
    /** Of those, closed as lost. */
    closed: number;
    /** Of those, left open: their pipeline has no lost stage, or another writer closed or trashed them first. */
    skipped: number;
    /** Open tasks on the closed deals, and on no deal still open, marked done with them. */
    tasksDone: number;
}

/** The clean-up acts for the workspace, not for a member: the history and timeline say the system did it. */
const SYSTEM: Actor = { kind: 'system', id: null };

/** A job acting for the workspace: no caller, every record of the workspace in reach. */
function jobContext(workspaceId: string): WorkspaceRunContext {
    return { workspaceId, capabilities: new Set(), actor: SYSTEM };
}

/**
 * The open Bigin-imported deals whose last activity is older than `months` — the latest of: the deal's creation
 * (restored from the Bigin export), Bigin's own modified time (`external_updated_at`), a stage change someone made
 * (not an import's placement, not a stage delete's sweep), and the newest activity entry (`ACTIVITY_KIND_PATTERNS`)
 * on the deal or on its contact. A date in the future (a synced message with a bad header) counts as now.
 * One set-based read, ordered by id, so the estimate and the apply read the same deals.
 *
 * `backlog.nobody` (the `unowned` run) reads another set by the same clock: imported deals from any source with no
 * owner and no contact an active member owns — `nobody` being the members who own nothing (left, or a shared mailbox).
 * `backlog.newOf` reads the imported deals of those members still in their pipeline's first open stage with no amount.
 */
export async function findStaleDeals(
    owner: PrismaService,
    workspaceId: string,
    months: number,
    backlog: { nobody?: readonly string[]; newOf?: readonly string[]; stage?: string } = {},
): Promise<string[]> {
    const { nobody, newOf, stage } = backlog;
    const inStage = stage
        ? Prisma.sql`o.stage_id IN (
                  SELECT s.id FROM pipeline_stages s
                  WHERE s.pipeline_id = o.pipeline_id AND s.kind = 'open' AND lower(s.name) = lower(${stage}))`
        : Prisma.sql`o.stage_id = (
                  SELECT s.id FROM pipeline_stages s
                  WHERE s.pipeline_id = o.pipeline_id AND s.kind = 'open'
                  ORDER BY s.position, s.id LIMIT 1)`;
    const candidates = newOf
        ? Prisma.sql`
            LEFT JOIN bigin_import_links l
              ON l.workspace_id = o.workspace_id AND l.local_type = 'opportunity' AND l.local_id = o.id
            WHERE o.workspace_id = ${workspaceId}::uuid AND o.deleted_at IS NULL AND o.closed_at IS NULL
              AND o.created_by ->> 'kind' = 'import' AND o.owner_id::text = ANY (${[...newOf]}::text[])
              AND COALESCE(o.amount_minor, 0) = 0
              AND ${inStage}`
        : nobody
          ? Prisma.sql`
            LEFT JOIN bigin_import_links l
              ON l.workspace_id = o.workspace_id AND l.local_type = 'opportunity' AND l.local_id = o.id
            WHERE o.workspace_id = ${workspaceId}::uuid AND o.deleted_at IS NULL AND o.closed_at IS NULL
              AND o.owner_id IS NULL AND o.created_by ->> 'kind' = 'import'
              AND NOT EXISTS (
                  SELECT 1 FROM people p
                  WHERE p.id = o.point_of_contact_id AND p.deleted_at IS NULL AND p.owner_id IS NOT NULL
                    AND p.owner_id::text <> ALL (${[...nobody]}::text[]))`
          : Prisma.sql`
            JOIN bigin_import_links l
              ON l.workspace_id = o.workspace_id AND l.local_type = 'opportunity' AND l.local_id = o.id
            WHERE o.workspace_id = ${workspaceId}::uuid AND o.deleted_at IS NULL AND o.closed_at IS NULL`;
    const rows = await owner.$queryRaw<{ id: string }[]>`
        WITH d AS (
            SELECT o.id, o.point_of_contact_id, o.created_at, l.external_updated_at
            FROM opportunities o
            ${candidates}),
        sh AS (
            SELECT opportunity_id, max(entered_at) AS at
            FROM opportunity_stage_history
            WHERE workspace_id = ${workspaceId}::uuid AND reason NOT IN ('import', 'stage_deleted')
            GROUP BY 1),
        ta AS (
            SELECT target_type, target_id, max(least(happened_at, now())) AS at
            FROM timeline_activities
            WHERE workspace_id = ${workspaceId}::uuid AND target_type IN ('opportunity', 'person')
              AND kind LIKE ANY (${ACTIVITY_KIND_PATTERNS}::text[])
              AND actor ->> 'kind' <> 'import'
            GROUP BY 1, 2)
        SELECT d.id::text AS id
        FROM d
        LEFT JOIN sh ON sh.opportunity_id = d.id
        LEFT JOIN ta t1 ON t1.target_type = 'opportunity' AND t1.target_id = d.id
        LEFT JOIN ta t2 ON t2.target_type = 'person' AND t2.target_id = d.point_of_contact_id
        WHERE greatest(d.created_at, d.external_updated_at, sh.at, t1.at, t2.at) < now() - make_interval(months => ${months}::int)
        ORDER BY d.id`;
    return rows.map((r) => r.id);
}

/**
 * Closes every stale imported deal (`findStaleDeals`) as lost — `STALE_LOST_REASON_CODE`, the free text naming the
 * clean-up — in its pipeline's lost stage, through the one stage writer (`StageMoveService.move`), `chunk` deals a
 * transaction, each close on the deal's history and timeline as the system's, its `deal.lost` kept internal: the
 * derived contact statuses and cadences follow it, webhooks never see it. Re-running changes nothing once done.
 * Counts only: no record is named.
 */
export async function closeStaleDeals(
    app: INestApplicationContext,
    workspaceId: string,
    options: CloseStaleOptions,
): Promise<CloseStaleReport> {
    const owner = app.get(PrismaService);
    const rls = app.get(RlsPrismaService);
    const moves = app.get(StageMoveService);
    const tasks = app.get(TasksService);
    const events = app.get(DomainEvents);
    const context = jobContext(workspaceId);
    const progress = options.onProgress ?? (() => undefined);
    const months = options.months ?? DEFAULT_IDLE_MONTHS;
    const chunk = options.chunk ?? DEFAULT_CHUNK;
    if (!Number.isInteger(months) || months < 1) throw new Error('months must be a whole number, 1 or more');
    if (!Number.isInteger(chunk) || chunk < 1) throw new Error('chunk must be a whole number of deals, 1 or more');

    const unowned = options.unowned === true;
    const newOf = options.newOf;
    if (unowned && newOf) throw new Error('one backlog at a time: unowned or newOf');
    if (newOf && newOf.length === 0) throw new Error('newOf names at least one member');
    const stage = options.stage?.trim() || undefined;
    if (stage && !newOf) throw new Error('a stage is read with newOf');
    const nobody = unowned
        ? [...(await rls.withWorkspace(workspaceId, async (tx) => ownerlessMembers(tx, await guardrailSettings(tx))))]
        : undefined;
    const stale = await findStaleDeals(owner, workspaceId, months, {
        ...(nobody ? { nobody } : {}),
        ...(newOf ? { newOf } : {}),
        ...(stage ? { stage } : {}),
    });
    const report: CloseStaleReport = { stale: stale.length, closed: 0, skipped: 0, tasksDone: 0 };
    if (!options.apply) return report;

    const close = {
        lostReason: staleLostReason(months, newOf ? 'new' : unowned ? 'unowned' : 'bigin', stage),
        lostReasonCode: STALE_LOST_REASON_CODE,
    };
    /** The lost stage of each pipeline met, by pipeline id (`null`: it has none). */
    const lostStages = new Map<string, string | null>();
    for (let at = 0; at < stale.length; at += chunk) {
        const ids = stale.slice(at, at + chunk);
        const done = await rls.withWorkspace(workspaceId, async (tx) => {
            const deals = await tx.opportunity.findMany({
                where: { id: { in: ids }, deletedAt: null, closedAt: null },
                select: { id: true, workspaceId: true, pipelineId: true, stageId: true },
            });
            let closed = 0;
            let tasksDone = 0;
            for (const deal of deals) {
                let lost = lostStages.get(deal.pipelineId);
                if (lost === undefined) {
                    const stage = await tx.pipelineStage.findFirst({
                        where: { pipelineId: deal.pipelineId, kind: 'lost' },
                        orderBy: { position: 'asc' },
                        select: { id: true },
                    });
                    lost = stage?.id ?? null;
                    lostStages.set(deal.pipelineId, lost);
                }
                if (lost === null) continue;
                const outcome = await moves.move(tx, deal, lost, SYSTEM, {
                    reason: 'rule',
                    allowBackward: true,
                    close,
                });
                if (outcome.outcome !== 'moved') continue;
                await moves.announce(tx, workspaceId, deal.id, SYSTEM, outcome, { internal: true });
                closed += 1;
                tasksDone += await finishTasksOf(tx, context, tasks, events, deal.id);
            }
            return { closed, tasksDone };
        });
        report.closed += done.closed;
        report.skipped += ids.length - done.closed;
        report.tasksDone += done.tasksDone;
        if ((at / chunk) % 50 === 0 || at + chunk >= stale.length) {
            progress(`… ${report.closed} of ${report.stale} closed, ${report.skipped} skipped`);
        }
    }
    return report;
}

/**
 * A follow-up on a dead deal has no reader: every open task on the deal just closed, unless it is also on a deal
 * still open, is marked done through the task service — the system's, its `task.updated` internal — so the
 * Dashboard's task list shows what is left to do, not what the backlog forgot. Returns how many.
 */
async function finishTasksOf(
    tx: WorkspaceClient,
    context: WorkspaceRunContext,
    tasks: TasksService,
    events: DomainEvents,
    dealId: string,
): Promise<number> {
    const open = await tx.task.findMany({
        where: {
            deletedAt: null,
            status: { not: 'done' },
            targets: { some: { targetType: 'opportunity', targetId: dealId } },
        },
        select: { id: true, targets: { select: { targetType: true, targetId: true } } },
    });
    let done = 0;
    for (const task of open) {
        const otherDeals = task.targets
            .filter((t) => t.targetType === 'opportunity' && t.targetId !== dealId)
            .map((t) => t.targetId);
        if (otherDeals.length) {
            const live = await tx.opportunity.count({
                where: { id: { in: otherDeals }, deletedAt: null, closedAt: null },
            });
            if (live > 0) continue;
        }
        const { event } = await tasks.updateIn(tx, context, task.id, { status: 'done' });
        if (event) await events.record(tx, { ...event, internal: true });
        done += 1;
    }
    return done;
}

/** The flags of a run, or `null` when they do not read. */
export function parseArgs(args: readonly string[]): { slug: string; options: CloseStaleOptions } | null {
    const [slug, ...flags] = args;
    if (!slug || slug.startsWith('--')) return null;
    const options: CloseStaleOptions = { apply: false };
    let mode: 'estimate' | 'apply' | undefined;
    for (let i = 0; i < flags.length; i++) {
        const flag = flags[i];
        if (flag === '--estimate' || flag === '--apply') {
            if (mode) return null;
            mode = flag === '--apply' ? 'apply' : 'estimate';
            options.apply = mode === 'apply';
        } else if (flag === '--unowned') {
            options.unowned = true;
        } else if (flag === '--new-of') {
            const ids = (flags[++i] ?? '').split(',').filter(Boolean);
            if (ids.length === 0) return null;
            options.newOf = ids;
        } else if (flag === '--stage') {
            const name = (flags[++i] ?? '').trim();
            if (!name) return null;
            options.stage = name;
        } else if (flag === '--months' || flag === '--chunk') {
            const n = Number(flags[++i]);
            if (!Number.isInteger(n) || n < 1) return null;
            if (flag === '--months') options.months = n;
            else options.chunk = n;
        } else {
            return null;
        }
    }
    if (options.unowned && options.newOf) return null;
    if (options.stage && !options.newOf) return null;
    return mode ? { slug, options } : null;
}

/**
 * `node dist/cli/close-stale-deals.js <workspace-slug> --estimate|--apply [--unowned] [--months <n>] [--chunk <n>]` — run on the
 * server in its own container (a `docker compose run`, so a deploy cannot stop it), after a backup, when the outbox
 * is quiet: every close is a `deal.lost` the relay then delivers (timeline, contact status, cadence). The Bigin
 * backlog: a hundred thousand open deals nobody has touched since the migration, most of them silent for a year or
 * more. `--estimate` changes nothing and prints what `--apply` would close; `--months` is the cut-off
 * (`DEFAULT_IDLE_MONTHS`); `--chunk` the deals closed per transaction (`DEFAULT_CHUNK`). A run that stops partway is
 * rerun as it was: it continues from the deals still open. `--unowned` reads the other backlog instead: imported
 * deals nobody owns and nobody could be given (`CloseStaleOptions.unowned`), idle past the same cut-off; `--new-of`
 * the never-worked deals of the members named (`CloseStaleOptions.newOf`), or with `--stage` their deals left in
 * that stage.
 */
async function main(): Promise<void> {
    const parsed = parseArgs(process.argv.slice(2));
    if (!parsed) throw new Error(USAGE);
    // A one-off process: no worker, relay or schedule of its own — the running API delivers what it records.
    for (const flag of [
        'WEBHOOK_WORKER',
        'MAIL_SYNC_WORKER',
        'MAIL_SEND_WORKER',
        'SEQUENCE_WORKER',
        'CALENDAR_SYNC_WORKER',
        'NOTIFICATIONS_WORKER',
        'TWENTY_IMPORT_WORKER',
        'ENRICHMENT_WORKER',
        'OUTBOX_RELAY',
        'TRANSACTIONAL_MAIL_RELAY',
    ]) {
        process.env[flag] = '0';
    }
    const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
    try {
        const workspace = await app
            .get(PrismaService)
            .workspace.findUnique({ where: { slug: parsed.slug }, select: { id: true } });
        if (!workspace) throw new Error(`no workspace ${parsed.slug}`);
        const months = parsed.options.months ?? DEFAULT_IDLE_MONTHS;
        const report = await closeStaleDeals(app, workspace.id, {
            ...parsed.options,
            onProgress: (line) => console.error(line),
        });
        const what = parsed.options.newOf
            ? parsed.options.stage
                ? `imported deals of the named members left in ${parsed.options.stage} with no amount`
                : 'never-worked imported deals of the named members'
            : parsed.options.unowned
              ? 'imported deals nobody owns'
              : 'imported deals';
        if (parsed.options.apply) {
            console.log(
                `closed: ${report.closed} of ${report.stale} ${what} idle ${months}+ months as lost (${report.skipped} skipped: no lost stage, or closed meanwhile); ${report.tasksDone} open tasks on them marked done`,
            );
        } else {
            console.log(`would close: ${report.stale} ${what} idle ${months}+ months as lost`);
            console.log('estimate: nothing changed; add --apply to do it');
        }
    } finally {
        await app.close();
    }
}

if (require.main === module) {
    main().catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
    });
}

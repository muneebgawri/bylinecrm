import 'reflect-metadata';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { DomainEvents } from '../events/domain-events.service';
import { guardrailSettings, ownerlessMembers } from '../guardrails/guardrail-settings';
import { PrismaService } from '../infra/prisma.service';
import { RlsPrismaService } from '../infra/rls-prisma.service';
import { WorkspaceContext } from '../infra/workspace-context';
import { OpportunitiesService } from '../records/opportunities.service';
import { TransfersService } from '../transfers/transfers.service';
import { importJobContext, quietWorkers } from './job-common';

const USAGE = 'usage: node dist/cli/merge-duplicate-deals.js <workspace-slug> --estimate|--apply';

/** The reason on the hand-over that gave the deal kept the owner its duplicates named. */
export const TRANSFER_REASON_DUPLICATE_DEAL = 'Duplicate deals merged: the owner of the duplicates';

/**
 * The timeline entries that are a deal's own: a note, a task or a call someone put on it, and what NewswireOS
 * reported for it. Mail and meetings are not: the sync files each on every open deal of the contact
 * (`mail-sync/matching.ts`), so every duplicate shows the same ones and the deal kept keeps them. Nor is an
 * ownership hand-over, which is bookkeeping.
 */
export const OWN_ACTIVITY_KIND_PATTERNS: readonly string[] = [
    'linked-note.%',
    'linked-task.%',
    'linked-call.%',
    'external.newswireos_%',
];

export interface MergeDealsOptions {
    /** Write: without it, nothing changes and the counts say what `--apply` would do. */
    apply: boolean;
    onProgress?: (line: string) => void;
}

export interface MergeDealsReport {
    /** Contacts with more than one open deal of the same name. */
    groups: number;
    /** The open deals in those groups. */
    deals: number;
    /** Duplicates removed: empty ones, beside the deal kept. */
    removed: number;
    /** Deals kept that were nobody's and were given the one active owner their duplicates named. */
    keptGivenOwner: number;
    /** Duplicates left because they carry something of their own (an amount, activity, a task, an invoice, mail). */
    leftWithContent: number;
    /** Groups left whole: their deals are more than one active member's, and whose the deal is is not the job's call. */
    groupsOfSeveralOwners: number;
    /** Groups left as they were: refused (the reason is on stderr, no record named). */
    failed: number;
}

interface Deal {
    id: string;
    owner_id: string | null;
    position: number;
    created_at: Date;
    carries: boolean;
}

/**
 * The import brought the same deal in more than once: one contact, one deal name, several open deals (a row per
 * campaign in the old system). For each such contact and name, one deal is kept — the one that carries something
 * (an amount, a note, task or call of its own, an invoice, a payment, mail written from it, a sequence), else the
 * furthest along, else the oldest
 * — and the others are removed when they carry nothing: softly, as from the deal's page, so each can be restored.
 * A duplicate that carries something stays. When the deal kept is nobody's and the group names exactly one active
 * owner, the deal kept is given to them (a silent hand-over on its ownership history). A group whose deals are
 * several active members' is left whole. Through the record service, a group per transaction, kept in BylineCRM
 * (`internal`). Re-running changes nothing once done. Counts only: no record is named.
 */
export async function mergeDuplicateDeals(
    app: INestApplicationContext,
    workspaceId: string,
    options: MergeDealsOptions,
): Promise<MergeDealsReport> {
    const owner = app.get(PrismaService);
    const rls = app.get(RlsPrismaService);
    const scope = app.get(WorkspaceContext);
    const deals = app.get(OpportunitiesService);
    const transfers = app.get(TransfersService);
    const events = app.get(DomainEvents);
    const context = importJobContext(workspaceId);
    const progress = options.onProgress ?? (() => undefined);
    const report: MergeDealsReport = {
        groups: 0,
        deals: 0,
        removed: 0,
        keptGivenOwner: 0,
        leftWithContent: 0,
        groupsOfSeveralOwners: 0,
        failed: 0,
    };
    const nobody = await rls.withWorkspace(workspaceId, async (tx) =>
        ownerlessMembers(tx, await guardrailSettings(tx)),
    );
    const active = (id: string | null) => (id !== null && !nobody.has(id) ? id : null);

    // Every open deal of a contact who has more than one of the same name, with whether it carries anything.
    const rows = await owner.$queryRaw<(Deal & { contact_id: string; name_key: string })[]>`
        WITH g AS (
            SELECT d.point_of_contact_id AS contact_id, lower(btrim(d.name)) AS name_key
            FROM opportunities d
            WHERE d.workspace_id = ${workspaceId}::uuid AND d.deleted_at IS NULL AND d.closed_at IS NULL
              AND d.point_of_contact_id IS NOT NULL
            GROUP BY 1, 2 HAVING count(*) > 1)
        SELECT d.id::text AS id, g.contact_id::text AS contact_id, g.name_key, d.owner_id::text AS owner_id,
               s.position, d.created_at,
               (COALESCE(d.amount_minor, 0) > 0
                OR EXISTS (SELECT 1 FROM timeline_activities t
                           WHERE t.workspace_id = d.workspace_id AND t.target_id = d.id AND t.target_type = 'opportunity'
                             AND t.kind LIKE ANY (${OWN_ACTIVITY_KIND_PATTERNS}::text[]))
                OR EXISTS (SELECT 1 FROM task_targets tt WHERE tt.target_type = 'opportunity' AND tt.target_id = d.id)
                OR EXISTS (SELECT 1 FROM deal_invoices i WHERE i.opportunity_id = d.id)
                OR EXISTS (SELECT 1 FROM newswireos_payments n WHERE n.opportunity_id = d.id)
                OR EXISTS (SELECT 1 FROM sequence_enrolments e WHERE e.deal_id = d.id)
                OR EXISTS (SELECT 1 FROM mail_drafts m WHERE m.deal_id = d.id)
                OR EXISTS (SELECT 1 FROM mail_outbound m WHERE m.deal_id = d.id)) AS carries
        FROM g
        JOIN opportunities d ON d.workspace_id = ${workspaceId}::uuid AND d.point_of_contact_id = g.contact_id
         AND lower(btrim(d.name)) = g.name_key AND d.deleted_at IS NULL AND d.closed_at IS NULL
        JOIN pipeline_stages s ON s.id = d.stage_id
        ORDER BY g.contact_id, g.name_key, d.id`;
    const groups = new Map<string, Deal[]>();
    for (const r of rows) {
        const key = `${r.contact_id} ${r.name_key}`;
        const list = groups.get(key) ?? [];
        list.push(r);
        groups.set(key, list);
    }
    report.groups = groups.size;
    report.deals = rows.length;

    let done = 0;
    for (const group of groups.values()) {
        done += 1;
        const owners = new Set(group.map((d) => active(d.owner_id)).filter((id): id is string => id !== null));
        if (owners.size > 1) {
            report.groupsOfSeveralOwners += 1;
            continue;
        }
        const [kept, ...others] = [...group].sort(
            (a, b) =>
                Number(b.carries) - Number(a.carries) ||
                b.position - a.position ||
                a.created_at.getTime() - b.created_at.getTime() ||
                a.id.localeCompare(b.id),
        ) as [Deal, ...Deal[]];
        const remove = others.filter((d) => !d.carries);
        const to = [...owners][0] ?? null;
        const give = to !== null && active(kept.owner_id) === null;
        report.leftWithContent += others.length - remove.length;
        if (options.apply && (remove.length > 0 || give)) {
            try {
                await scope.run(context, () =>
                    rls.withWorkspace(workspaceId, async (tx) => {
                        // Read again in the transaction: a deal closed, removed or re-owned since is not this run's.
                        const live = await tx.opportunity.findMany({
                            where: { id: { in: group.map((d) => d.id) }, deletedAt: null, closedAt: null },
                            select: { id: true, ownerId: true },
                        });
                        const same = group.every((d) => live.find((l) => l.id === d.id)?.ownerId === d.owner_id);
                        if (live.length !== group.length || !same) throw new Error('changed since it was read');
                        if (give) {
                            const updated = await deals.updateIn(tx, context, kept.id, { ownerId: to });
                            if (updated.event) await events.record(tx, { ...updated.event, internal: true });
                            for (const e of updated.taskEvents) await events.record(tx, { ...e, internal: true });
                            await transfers.recordHandOverIn(tx, context, {
                                from: null,
                                to,
                                target: { type: 'opportunity', id: kept.id },
                                reason: TRANSFER_REASON_DUPLICATE_DEAL,
                                silent: true,
                            });
                        }
                        for (const d of remove) {
                            const removed = await deals.removeIn(tx, context, d.id);
                            await events.record(tx, { ...removed.event, internal: true });
                        }
                    }),
                );
            } catch (error) {
                report.failed += 1;
                progress(`refused: ${error instanceof Error ? error.message : String(error)}`);
                continue;
            }
        }
        report.removed += remove.length;
        if (give) report.keptGivenOwner += 1;
        if (done % 500 === 0) progress(`… ${done} of ${groups.size} groups: ${report.removed} duplicates removed`);
    }
    return report;
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const slug = args[0];
    const flags = args.slice(1);
    const known = new Set(['--estimate', '--apply']);
    const apply = flags.includes('--apply');
    if (!slug || slug.startsWith('--') || flags.some((f) => !known.has(f)) || apply === flags.includes('--estimate')) {
        throw new Error(USAGE);
    }
    quietWorkers();
    const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
    try {
        const workspace = await app.get(PrismaService).workspace.findUnique({ where: { slug }, select: { id: true } });
        if (!workspace) throw new Error(`no workspace ${slug}`);
        const report = await mergeDuplicateDeals(app, workspace.id, {
            apply,
            onProgress: (line) => console.error(line),
        });
        const would = apply ? '' : 'would be ';
        console.log(`${report.groups} contacts with more than one open deal of the same name (${report.deals} deals)`);
        console.log(`${would}removed, empty duplicates: ${report.removed}`);
        console.log(`${would}given their duplicates’ owner, deals kept that were nobody’s: ${report.keptGivenOwner}`);
        console.log(`left, duplicates that carry something of their own: ${report.leftWithContent}`);
        console.log(`left whole, groups whose deals are several members’: ${report.groupsOfSeveralOwners}`);
        if (apply) console.log(`refused and left as they were: ${report.failed} groups`);
        else console.log('estimate: nothing changed; add --apply to do it');
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

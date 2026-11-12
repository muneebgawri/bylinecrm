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
import { importJobContext, JOB_WRITE_CHUNK, quietWorkers } from './job-common';

const USAGE = 'usage: node dist/cli/assign-deal-owners.js <workspace-slug> --estimate|--apply [--batch <n>]';

/** Deals read per statement (`--batch`): a page, never the whole table. */
export const DEFAULT_BATCH = 500;

/** The reason on the hand-over that gave an unowned deal the owner of its contact. */
export const TRANSFER_REASON_DEAL_OWNER_FILL = 'Deal ownership: the contact’s owner';

export interface AssignDealsOptions {
    /** Write: without it, nothing changes and the counts say what `--apply` would do. */
    apply: boolean;
    /** Deals read per statement; `DEFAULT_BATCH` when absent. */
    batch?: number | undefined;
    onProgress?: (line: string) => void;
}

export interface AssignDealsReport {
    /** Open deals with no owner. */
    deals: number;
    /** Of those, given to the owner of their contact. */
    assigned: number;
    /** Left: no contact, or a contact nobody active owns (no owner, one who left, a shared mailbox). */
    noContactOwner: number;
    /** Left: the deal's company is another active member's — a deal with a company is its owner's (OWN-2). */
    companyElsewhere: number;
    /** The members given deals, and the most one of them was given. */
    owners: number;
    mostToOne: number;
    /** Deals left as they were: their chunk was refused (the reason is on stderr, no record named). */
    failed: number;
}

/**
 * The import left open deals with no owner: on nobody's pipeline, nobody's Dashboard. Each one whose contact has an
 * active owner is given to that owner — unless the deal's company is another active member's, whose it would be
 * (OWN-2) — as an import fills an empty owner: the record service's write and a silent hand-over on the deal's
 * ownership history (`recordHandOverIn`), `JOB_WRITE_CHUNK` per transaction, kept in BylineCRM (`internal`). A member
 * who has left, or a shared mailbox, is nobody (as to the guard). Re-running changes nothing once done. Counts only.
 */
export async function assignDealOwners(
    app: INestApplicationContext,
    workspaceId: string,
    options: AssignDealsOptions,
): Promise<AssignDealsReport> {
    const owner = app.get(PrismaService);
    const rls = app.get(RlsPrismaService);
    const scope = app.get(WorkspaceContext);
    const deals = app.get(OpportunitiesService);
    const transfers = app.get(TransfersService);
    const events = app.get(DomainEvents);
    const context = importJobContext(workspaceId);
    const progress = options.onProgress ?? (() => undefined);
    const BATCH = options.batch ?? DEFAULT_BATCH;
    if (!Number.isInteger(BATCH) || BATCH < 1) throw new Error('batch must be a whole number of deals, 1 or more');
    const report: AssignDealsReport = {
        deals: 0,
        assigned: 0,
        noContactOwner: 0,
        companyElsewhere: 0,
        owners: 0,
        mostToOne: 0,
        failed: 0,
    };
    const nobody = await rls.withWorkspace(workspaceId, async (tx) =>
        ownerlessMembers(tx, await guardrailSettings(tx)),
    );
    const active = (id: string | null) => (id !== null && !nobody.has(id) ? id : null);
    const given = new Map<string, number>();

    let after = '00000000-0000-0000-0000-000000000000';
    for (;;) {
        const page = await owner.$queryRaw<
            { id: string; contact_owner: string | null; company_owner: string | null }[]
        >`
            SELECT d.id::text AS id, p.owner_id::text AS contact_owner, c.owner_id::text AS company_owner
            FROM opportunities d
            JOIN pipeline_stages s ON s.id = d.stage_id AND s.kind = 'open'
            LEFT JOIN people p ON p.id = d.point_of_contact_id AND p.deleted_at IS NULL
            LEFT JOIN companies c ON c.id = d.company_id AND c.deleted_at IS NULL
            WHERE d.workspace_id = ${workspaceId}::uuid AND d.deleted_at IS NULL AND d.closed_at IS NULL
              AND d.owner_id IS NULL AND d.id > ${after}::uuid
            ORDER BY d.id LIMIT ${BATCH}`;
        if (page.length === 0) break;
        report.deals += page.length;
        const fills: { id: string; to: string }[] = [];
        for (const d of page) {
            const to = active(d.contact_owner);
            const companyOwner = active(d.company_owner);
            if (!to) report.noContactOwner += 1;
            else if (companyOwner && companyOwner !== to) report.companyElsewhere += 1;
            else fills.push({ id: d.id, to });
        }
        for (let at = 0; at < fills.length; at += JOB_WRITE_CHUNK) {
            const chunk = fills.slice(at, at + JOB_WRITE_CHUNK);
            let done: string[] = chunk.map((f) => f.to);
            if (options.apply) {
                try {
                    done = await scope.run(context, () =>
                        rls.withWorkspace(workspaceId, async (tx) => {
                            const filled: string[] = [];
                            for (const f of chunk) {
                                // A deal given an owner, closed or removed since the read is left as it is.
                                const still = await tx.opportunity.findFirst({
                                    where: { id: f.id, ownerId: null, deletedAt: null, closedAt: null },
                                    select: { id: true },
                                });
                                if (!still) continue;
                                const updated = await deals.updateIn(tx, context, f.id, { ownerId: f.to });
                                if (updated.event) await events.record(tx, { ...updated.event, internal: true });
                                for (const e of updated.taskEvents) await events.record(tx, { ...e, internal: true });
                                await transfers.recordHandOverIn(tx, context, {
                                    from: null,
                                    to: f.to,
                                    target: { type: 'opportunity', id: f.id },
                                    reason: TRANSFER_REASON_DEAL_OWNER_FILL,
                                    silent: true,
                                });
                                filled.push(f.to);
                            }
                            return filled;
                        }),
                    );
                } catch (error) {
                    report.failed += chunk.length;
                    progress(`refused: ${error instanceof Error ? error.message : String(error)}`);
                    done = [];
                }
            }
            report.assigned += done.length;
            for (const to of done) given.set(to, (given.get(to) ?? 0) + 1);
        }
        after = page[page.length - 1]!.id;
        progress(`… ${report.deals} open deals without an owner, ${report.assigned} given to their contact’s owner`);
    }
    report.owners = given.size;
    report.mostToOne = Math.max(0, ...given.values());
    return report;
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const slug = args[0];
    const flags = args.slice(1);
    let batch: number | undefined;
    const at = flags.indexOf('--batch');
    if (at >= 0) {
        batch = Number(flags[at + 1]);
        if (!Number.isInteger(batch) || batch < 1) throw new Error(USAGE);
        flags.splice(at, 2);
    }
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
        const report = await assignDealOwners(app, workspace.id, {
            apply,
            batch,
            onProgress: (line) => console.error(line),
        });
        const would = apply ? '' : 'would be ';
        console.log(`${report.deals} open deals without an owner`);
        console.log(
            `${would}given to their contact’s owner: ${report.assigned}, among ${report.owners} members (at most ${report.mostToOne} to one)`,
        );
        console.log(`left, no contact or a contact nobody active owns: ${report.noContactOwner}`);
        console.log(`left, the deal’s company is another member’s: ${report.companyElsewhere}`);
        if (apply) console.log(`refused and left as they were: ${report.failed}`);
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

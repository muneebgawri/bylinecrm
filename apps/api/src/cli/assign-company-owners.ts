import 'reflect-metadata';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { PrismaService } from '../infra/prisma.service';
import { RlsPrismaService } from '../infra/rls-prisma.service';
import type { WorkspaceRunContext } from '../infra/workspace-context';
import { CompanyOwnership } from '../records/company-ownership';
import { TransfersService } from '../transfers/transfers.service';

const USAGE =
    'usage: node dist/cli/assign-company-owners.js <workspace-slug> --estimate|--apply [--reassign-people] [--batch <n>]';

/** Companies read per statement (`--batch`): a page, never the whole table. */
export const DEFAULT_BATCH = 200;

/**
 * Companies filled per transaction within a page — the Bigin import's lesson (`BIGIN_WRITE_CHUNK`, production
 * 2026-10-19, again 2026-11-11 here): a page of 1,000 fills in one transaction (a claim, a hand-over row and two
 * events each) outlived the 15-second transaction limit (`TRANSACTION_TIMEOUT_MS`) and was rolled back. A chunk is
 * its own short transaction; a chunk that fails leaves the ones before it committed, and a rerun continues from
 * the companies still without an owner.
 */
export const WRITE_CHUNK = 20;

/** The reason on the hand-over that gave an imported company the owner its people name. */
export const TRANSFER_REASON_COMPANY_OWNER_FILL = 'Company ownership: the first saver’s';

/** The reason on the move of a person to the owner of their company. */
export const TRANSFER_REASON_COMPANY_OWNER = 'Company ownership: the company is theirs';

export interface AssignOptions {
    /** Write: without it, nothing changes and the counts say what `--apply` would do. */
    apply: boolean;
    /** Also move each person at a company whose owner differs to the company's owner, with their open deals. */
    reassignPeople: boolean;
    /** Companies read per statement; `DEFAULT_BATCH` when absent. */
    batch?: number | undefined;
    onProgress?: (line: string) => void;
}

export interface AssignReport {
    /** Companies with no owner whose people have one: the companies filled (or that would be). */
    companies: number;
    /** Of those, companies filled: the rest name an owner who has left, and keep none. */
    assigned: number;
    /** `--reassign-people`: companies with a person whose owner differs from the company's. */
    companiesTouched: number;
    /** `--reassign-people`: people moved to their company's owner. */
    peopleMoved: number;
    /** `--reassign-people`: open deals those people are the contact of, moved with them. */
    dealsMoved: number;
}

/** A job acting for the workspace: no caller, so the ownership rule's checks do not bind it. */
function jobContext(workspaceId: string): WorkspaceRunContext {
    return { workspaceId, capabilities: new Set(), actor: { kind: 'system', id: null } };
}

/**
 * OWN-2d (`CompanyOwnership`): fills the owner of every live company that has none from its people — the owner of
 * the earliest live person saved at it, the first saver — a page of companies (`batch`) per read, `WRITE_CHUNK` fills
 * per transaction, each fill on the company's ownership history as an import's fill is (`recordHandOverIn`, silent).
 * With `reassignPeople`, then moves
 * every person at a company whose owner is not the company's to the company's owner, with the open deals they are
 * the contact of, through the transfer service (`reassign`: a forced transfer, its events written as for any move).
 * Re-running changes nothing once done. Counts only: no record is named.
 */
export async function assignCompanyOwners(
    app: INestApplicationContext,
    workspaceId: string,
    options: AssignOptions,
): Promise<AssignReport> {
    const owner = app.get(PrismaService);
    const rls = app.get(RlsPrismaService);
    const ownership = app.get(CompanyOwnership);
    const transfers = app.get(TransfersService);
    const context = jobContext(workspaceId);
    const progress = options.onProgress ?? (() => undefined);
    const BATCH = options.batch ?? DEFAULT_BATCH;
    if (!Number.isInteger(BATCH) || BATCH < 1) throw new Error('batch must be a whole number of companies, 1 or more');
    const report: AssignReport = { companies: 0, assigned: 0, companiesTouched: 0, peopleMoved: 0, dealsMoved: 0 };

    // 1. Companies with no owner, each with the owner of its first saved person (an active member).
    let after = '00000000-0000-0000-0000-000000000000';
    for (;;) {
        const batch = await owner.$queryRaw<{ id: string; owner_id: string | null }[]>`
            SELECT c.id::text AS id,
                   (SELECT p.owner_id::text FROM people p
                     JOIN workspace_members m ON m.id = p.owner_id AND m.left_at IS NULL
                     WHERE p.company_id = c.id AND p.deleted_at IS NULL
                     ORDER BY p.created_at, p.id LIMIT 1) AS owner_id
            FROM companies c
            WHERE c.workspace_id = ${workspaceId}::uuid AND c.owner_id IS NULL AND c.deleted_at IS NULL
              AND c.id > ${after}::uuid
              AND EXISTS (SELECT 1 FROM people p WHERE p.company_id = c.id AND p.deleted_at IS NULL AND p.owner_id IS NOT NULL)
            ORDER BY c.id LIMIT ${BATCH}`;
        if (batch.length === 0) break;
        report.companies += batch.length;
        const fills = batch.filter((c): c is { id: string; owner_id: string } => c.owner_id !== null);
        if (options.apply) {
            // A page is written in chunks, each its own transaction (the class comment on `WRITE_CHUNK`).
            for (let at = 0; at < fills.length; at += WRITE_CHUNK) {
                const chunk = fills.slice(at, at + WRITE_CHUNK);
                report.assigned += await rls.withWorkspace(workspaceId, async (tx) => {
                    let claimed = 0;
                    for (const c of chunk) {
                        if (!(await ownership.claim(tx, context, c.id, c.owner_id))) continue;
                        await transfers.recordHandOverIn(tx, context, {
                            from: null,
                            to: c.owner_id,
                            target: { type: 'company', id: c.id },
                            reason: TRANSFER_REASON_COMPANY_OWNER_FILL,
                            silent: true,
                        });
                        claimed += 1;
                    }
                    return claimed;
                });
            }
        } else {
            report.assigned += fills.length;
        }
        after = batch[batch.length - 1]!.id;
        progress(`… ${report.companies} companies without an owner, ${report.assigned} filled`);
    }
    if (!options.reassignPeople) return report;

    // 2. People at a company whose owner (the one it has, else the one step 1 gives it) is not theirs, with the open
    //    deals they are the contact of — what the transfer's unit moves.
    after = '00000000-0000-0000-0000-000000000000';
    for (;;) {
        const batch = await owner.$queryRaw<{ id: string; owner_id: string; people: number; deals: number }[]>`
            WITH owned AS (
                SELECT c.id,
                       coalesce(c.owner_id,
                                (SELECT p.owner_id FROM people p
                                  JOIN workspace_members m ON m.id = p.owner_id AND m.left_at IS NULL
                                  WHERE p.company_id = c.id AND p.deleted_at IS NULL
                                  ORDER BY p.created_at, p.id LIMIT 1)) AS owner_id
                FROM companies c
                WHERE c.workspace_id = ${workspaceId}::uuid AND c.deleted_at IS NULL AND c.id > ${after}::uuid
                ORDER BY c.id LIMIT ${BATCH}
            )
            SELECT o.id::text AS id, o.owner_id::text AS owner_id,
                   count(p.id)::int AS people,
                   coalesce(sum((SELECT count(*) FROM opportunities d
                                  WHERE d.point_of_contact_id = p.id AND d.deleted_at IS NULL AND d.closed_at IS NULL
                                    AND d.owner_id IS NOT DISTINCT FROM p.owner_id)), 0)::int AS deals
            FROM owned o
            LEFT JOIN people p ON p.company_id = o.id AND p.deleted_at IS NULL AND p.owner_id IS DISTINCT FROM o.owner_id
            GROUP BY o.id, o.owner_id
            ORDER BY o.id`;
        if (batch.length === 0) break;
        for (const c of batch) {
            if (c.people === 0 || c.owner_id === null) continue;
            report.companiesTouched += 1;
            if (!options.apply) {
                report.peopleMoved += c.people;
                report.dealsMoved += c.deals;
                continue;
            }
            const people = await owner.$queryRaw<{ id: string }[]>`
                SELECT p.id::text AS id FROM people p
                WHERE p.company_id = ${c.id}::uuid AND p.deleted_at IS NULL AND p.owner_id IS DISTINCT FROM ${c.owner_id}::uuid
                ORDER BY p.id`;
            for (const p of people) {
                const moved = await transfers.reassign(context, {
                    personId: p.id,
                    to: c.owner_id,
                    reason: TRANSFER_REASON_COMPANY_OWNER,
                    silent: true,
                });
                if (!moved) continue;
                report.peopleMoved += 1;
                report.dealsMoved += moved.moved.filter((t) => t.type === 'opportunity').length;
            }
        }
        after = batch[batch.length - 1]!.id;
        progress(`… ${report.companiesTouched} companies touched, ${report.peopleMoved} people moved`);
    }
    return report;
}

/**
 * `node dist/cli/assign-company-owners.js <workspace-slug> --estimate|--apply [--reassign-people]` — run on the server,
 * inside the api container, after a backup. The Bigin import set owners on people and not on their companies, so the
 * company-ownership rule (OWN-2) never fired for an imported company; this gives each such company the owner its
 * people name (see `assignCompanyOwners`). `--estimate` changes nothing and prints what `--apply` would do; `--batch`
 * is the companies read per statement (`DEFAULT_BATCH`). A run that stops partway is rerun as it was: it continues
 * from the companies still without an owner. The domain events go to the outbox; the running API's relay delivers
 * them (timeline, webhooks).
 */
async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const slug = args[0];
    const flags = args.slice(1);
    const known = new Set(['--estimate', '--apply', '--reassign-people']);
    const apply = flags.includes('--apply');
    let batch: number | undefined;
    const at = flags.indexOf('--batch');
    if (at >= 0) {
        batch = Number(flags[at + 1]);
        if (!Number.isInteger(batch) || batch < 1) throw new Error(USAGE);
        flags.splice(at, 2);
    }
    if (!slug || slug.startsWith('--') || flags.some((f) => !known.has(f)) || apply === flags.includes('--estimate')) {
        throw new Error(USAGE);
    }
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
        const workspace = await app.get(PrismaService).workspace.findUnique({ where: { slug }, select: { id: true } });
        if (!workspace) throw new Error(`no workspace ${slug}`);
        const report = await assignCompanyOwners(app, workspace.id, {
            apply,
            reassignPeople: flags.includes('--reassign-people'),
            batch,
            onProgress: (line) => console.error(line),
        });
        const did = apply ? 'filled' : 'would fill';
        console.log(
            `${did}: ${report.assigned} of ${report.companies} companies without an owner (the rest name a member who left)`,
        );
        if (flags.includes('--reassign-people')) {
            console.log(
                `${apply ? 'moved' : 'would move'}: ${report.peopleMoved} people and ${report.dealsMoved} open deals at ${report.companiesTouched} companies`,
            );
        }
        if (!apply) console.log('estimate: nothing changed; add --apply to do it');
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

import 'reflect-metadata';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { DomainEvents } from '../events/domain-events.service';
import { PrismaService } from '../infra/prisma.service';
import { RlsPrismaService } from '../infra/rls-prisma.service';
import { WorkspaceContext } from '../infra/workspace-context';
import { OpportunitiesService } from '../records/opportunities.service';
import { PeopleService } from '../records/people.service';
import { TransfersService } from '../transfers/transfers.service';
import { importJobContext, JOB_WRITE_CHUNK, quietWorkers } from './job-common';

const USAGE = 'usage: node dist/cli/release-departed-owners.js <workspace-slug> --estimate|--apply [--batch <n>]';

/** Records read per statement (`--batch`): a page, never the whole table. */
export const DEFAULT_BATCH = 500;

/** The reason on the move of a departed member's person, or deal, to the owner of its company. */
export const TRANSFER_REASON_DEPARTED_TO_COMPANY_OWNER = 'Departed owner: the company’s owner';

/** The reason on the move of a departed member's deal to the owner of its contact (the company is nobody's). */
export const TRANSFER_REASON_DEPARTED_TO_CONTACT_OWNER = 'Departed owner: the contact’s owner';

export interface ReleaseOptions {
    /** Write: without it, nothing changes and the counts say what `--apply` would do. */
    apply: boolean;
    /** Records read per statement; `DEFAULT_BATCH` when absent. */
    batch?: number | undefined;
    onProgress?: (line: string) => void;
}

export interface ReleaseReport {
    /** Live people a member who has left owns. */
    people: number;
    /** Of those, moved to the active owner of their company, with the open deals the departed member held with them. */
    peopleToCompanyOwner: number;
    /** Open deals that moved with those people. */
    dealsWithPeople: number;
    /** Of those people, left with no owner: their company has no active owner, or they have none. */
    peopleReleased: number;
    /** Open deals a member who has left still owns once the people are done. */
    deals: number;
    dealsToCompanyOwner: number;
    dealsToContactOwner: number;
    /** Left with no owner: nobody active owns the company or the contact. */
    dealsReleased: number;
    /** Records left as they were: their write was refused (the reason is on stderr, no record named). */
    failed: number;
}

const FIRST_ID = '00000000-0000-0000-0000-000000000000';

/**
 * A member who has left holds records nobody works: they sit on no one's Dashboard, and the guard reads them as
 * nobody's anyway (`ownerlessMembers`). This hands each to whoever the ownership rule says should have it (OWN-2):
 * a person to the active owner of their company, through the transfer service (`reassign`: a forced, silent move
 * whose unit is the person and the open deals the departed member held with them); else the person is left with
 * no owner, for a manager to hand out. Then each open deal still the departed member's goes to the active owner of
 * its company, else of its contact, else to no owner. A fill is the record service's write plus a silent hand-over
 * on the record's history, as `assign-deal-owners` writes one; a release is the record service's write alone. Writes
 * act as an import (`importJobContext`), so OWN-2f does not read them as anyone's work. Closed deals keep their
 * owner: they are history. Re-running changes nothing once done. Counts only: no record is named.
 */
export async function releaseDepartedOwners(
    app: INestApplicationContext,
    workspaceId: string,
    options: ReleaseOptions,
): Promise<ReleaseReport> {
    const owner = app.get(PrismaService);
    const rls = app.get(RlsPrismaService);
    const scope = app.get(WorkspaceContext);
    const people = app.get(PeopleService);
    const deals = app.get(OpportunitiesService);
    const transfers = app.get(TransfersService);
    const events = app.get(DomainEvents);
    const context = importJobContext(workspaceId);
    const progress = options.onProgress ?? (() => undefined);
    const BATCH = options.batch ?? DEFAULT_BATCH;
    if (!Number.isInteger(BATCH) || BATCH < 1) throw new Error('batch must be a whole number of records, 1 or more');
    const report: ReleaseReport = {
        people: 0,
        peopleToCompanyOwner: 0,
        dealsWithPeople: 0,
        peopleReleased: 0,
        deals: 0,
        dealsToCompanyOwner: 0,
        dealsToContactOwner: 0,
        dealsReleased: 0,
        failed: 0,
    };
    const refused = (count: number, error: unknown) => {
        report.failed += count;
        progress(`refused: ${error instanceof Error ? error.message : String(error)}`);
    };

    // 1. People: to their company's active owner (with the departed member's open deals with them), else nobody.
    let after = FIRST_ID;
    for (;;) {
        const page = await owner.$queryRaw<{ id: string; from: string; to: string | null; deals: number }[]>`
            SELECT p.id::text AS id, p.owner_id::text AS "from", cm.id::text AS "to",
                   (SELECT count(*) FROM opportunities d
                     WHERE d.point_of_contact_id = p.id AND d.deleted_at IS NULL AND d.closed_at IS NULL
                       AND d.owner_id = p.owner_id)::int AS deals
            FROM people p
            JOIN workspace_members gone ON gone.id = p.owner_id AND gone.left_at IS NOT NULL
            LEFT JOIN companies c ON c.id = p.company_id AND c.deleted_at IS NULL
            LEFT JOIN workspace_members cm ON cm.id = c.owner_id AND cm.left_at IS NULL
            WHERE p.workspace_id = ${workspaceId}::uuid AND p.deleted_at IS NULL AND p.id > ${after}::uuid
            ORDER BY p.id LIMIT ${BATCH}`;
        if (page.length === 0) break;
        report.people += page.length;
        const moves = page.filter((p): p is typeof p & { to: string } => p.to !== null);
        const releases = page.filter((p) => p.to === null);
        for (const p of moves) {
            if (!options.apply) {
                report.peopleToCompanyOwner += 1;
                report.dealsWithPeople += p.deals;
                continue;
            }
            try {
                const moved = await transfers.reassign(context, {
                    personId: p.id,
                    to: p.to,
                    reason: TRANSFER_REASON_DEPARTED_TO_COMPANY_OWNER,
                    silent: true,
                });
                if (!moved) continue;
                report.peopleToCompanyOwner += 1;
                report.dealsWithPeople += moved.moved.filter((t) => t.type === 'opportunity').length;
            } catch (error) {
                refused(1, error);
            }
        }
        for (let at = 0; at < releases.length; at += JOB_WRITE_CHUNK) {
            const chunk = releases.slice(at, at + JOB_WRITE_CHUNK);
            if (!options.apply) {
                report.peopleReleased += chunk.length;
                continue;
            }
            try {
                report.peopleReleased += await scope.run(context, () =>
                    rls.withWorkspace(workspaceId, async (tx) => {
                        let released = 0;
                        for (const p of chunk) {
                            // Moved or removed since the read: left as it is.
                            const still = await tx.person.findFirst({
                                where: { id: p.id, ownerId: p.from, deletedAt: null },
                                select: { id: true },
                            });
                            if (!still) continue;
                            const updated = await people.updateIn(tx, context, p.id, { ownerId: null });
                            if (updated.event) await events.record(tx, { ...updated.event, internal: true });
                            released += 1;
                        }
                        return released;
                    }),
                );
            } catch (error) {
                refused(chunk.length, error);
            }
        }
        after = page[page.length - 1]!.id;
        progress(
            `… ${report.people} people of members who left: ${report.peopleToCompanyOwner} to the company’s owner, ${report.peopleReleased} to nobody`,
        );
    }

    // 2. Open deals still a departed member's: the company's active owner, else the contact's, else nobody. Without
    //    --apply, the people step's moves have not happened, so a deal that would move with its contact is counted
    //    again here: the estimate's deal counts are an upper bound.
    after = FIRST_ID;
    for (;;) {
        const page = await owner.$queryRaw<
            { id: string; from: string; company_owner: string | null; contact_owner: string | null }[]
        >`
            SELECT d.id::text AS id, d.owner_id::text AS "from",
                   cm.id::text AS company_owner, pm.id::text AS contact_owner
            FROM opportunities d
            JOIN workspace_members gone ON gone.id = d.owner_id AND gone.left_at IS NOT NULL
            LEFT JOIN companies c ON c.id = d.company_id AND c.deleted_at IS NULL
            LEFT JOIN workspace_members cm ON cm.id = c.owner_id AND cm.left_at IS NULL
            LEFT JOIN people p ON p.id = d.point_of_contact_id AND p.deleted_at IS NULL
            LEFT JOIN workspace_members pm ON pm.id = p.owner_id AND pm.left_at IS NULL
            WHERE d.workspace_id = ${workspaceId}::uuid AND d.deleted_at IS NULL AND d.closed_at IS NULL
              AND d.id > ${after}::uuid
            ORDER BY d.id LIMIT ${BATCH}`;
        if (page.length === 0) break;
        report.deals += page.length;
        for (let at = 0; at < page.length; at += JOB_WRITE_CHUNK) {
            const chunk = page.slice(at, at + JOB_WRITE_CHUNK);
            const plan = chunk.map((d) => ({
                ...d,
                to: d.company_owner ?? d.contact_owner,
                why: d.company_owner
                    ? ('dealsToCompanyOwner' as const)
                    : d.contact_owner
                      ? ('dealsToContactOwner' as const)
                      : ('dealsReleased' as const),
            }));
            if (!options.apply) {
                for (const d of plan) report[d.why] += 1;
                continue;
            }
            try {
                const done = await scope.run(context, () =>
                    rls.withWorkspace(workspaceId, async (tx) => {
                        const written: typeof plan = [];
                        for (const d of plan) {
                            const still = await tx.opportunity.findFirst({
                                where: { id: d.id, ownerId: d.from, deletedAt: null, closedAt: null },
                                select: { id: true },
                            });
                            if (!still) continue;
                            const updated = await deals.updateIn(tx, context, d.id, { ownerId: d.to });
                            if (updated.event) await events.record(tx, { ...updated.event, internal: true });
                            for (const e of updated.taskEvents) await events.record(tx, { ...e, internal: true });
                            if (d.to) {
                                await transfers.recordHandOverIn(tx, context, {
                                    from: d.from,
                                    to: d.to,
                                    target: { type: 'opportunity', id: d.id },
                                    reason:
                                        d.why === 'dealsToCompanyOwner'
                                            ? TRANSFER_REASON_DEPARTED_TO_COMPANY_OWNER
                                            : TRANSFER_REASON_DEPARTED_TO_CONTACT_OWNER,
                                    silent: true,
                                });
                            }
                            written.push(d);
                        }
                        return written;
                    }),
                );
                for (const d of done) report[d.why] += 1;
            } catch (error) {
                refused(chunk.length, error);
            }
        }
        after = page[page.length - 1]!.id;
        progress(`… ${report.deals} open deals of members who left`);
    }
    return report;
}

/**
 * `node dist/cli/release-departed-owners.js <workspace-slug> --estimate|--apply [--batch <n>]` — run on the server, in
 * its own compose-run container, after a backup. `--estimate` changes nothing and prints what `--apply` would do. A
 * run that stops partway is rerun as it was: it continues from the records a departed member still owns. The domain
 * events go to the outbox; the running API's relay delivers them.
 */
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
        const r = await releaseDepartedOwners(app, workspace.id, {
            apply,
            batch,
            onProgress: (line) => console.error(line),
        });
        const would = apply ? '' : 'would be ';
        console.log(`${r.people} people owned by members who left`);
        console.log(
            `  ${would}moved to their company’s owner: ${r.peopleToCompanyOwner} (with ${r.dealsWithPeople} open deals)`,
        );
        console.log(`  ${would}left with no owner: ${r.peopleReleased}`);
        console.log(`${r.deals} open deals owned by members who left${apply ? ' after the people' : ' (upper bound)'}`);
        console.log(
            `  ${would}given to the company’s owner: ${r.dealsToCompanyOwner}; the contact’s owner: ${r.dealsToContactOwner}; no owner: ${r.dealsReleased}`,
        );
        if (apply) console.log(`refused and left as they were: ${r.failed}`);
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

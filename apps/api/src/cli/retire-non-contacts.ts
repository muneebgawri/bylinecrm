import 'reflect-metadata';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { Actor } from '@bylinecrm/shared';
import { AppModule } from '../app.module';
import { DomainEvents } from '../events/domain-events.service';
import { PrismaService } from '../infra/prisma.service';
import { RlsPrismaService } from '../infra/rls-prisma.service';
import type { WorkspaceRunContext } from '../infra/workspace-context';
import { notAContactReason, staffAddresses } from '../records/not-a-contact';
import { PeopleService } from '../records/people.service';

const USAGE = 'usage: node dist/cli/retire-non-contacts.js <workspace-slug> --estimate|--apply [--chunk <n>]';

/** People retired per transaction: each is one update and one event, well inside the 15-second transaction limit. */
export const DEFAULT_CHUNK = 20;

/** People read per page when the workspace's people are judged by the rule (ids and primary addresses only). */
const PAGE = 5000;

const SYSTEM: Actor = { kind: 'system', id: null };

function systemContext(workspaceId: string): WorkspaceRunContext {
    return { workspaceId, capabilities: new Set(), actor: SYSTEM };
}

export interface RetireOptions {
    /** Write: without it, nothing changes and the counts say what `--apply` would do. */
    apply: boolean;
    /** People retired per transaction; `DEFAULT_CHUNK` when absent. */
    chunk?: number | undefined;
    onProgress?: (line: string) => void;
}

export interface NonContact {
    id: string;
    /** A member's or a mailbox's address (`staff`), or an automated sender's (`system`). */
    kind: 'staff' | 'system';
}

export interface RetireReport {
    /** Live people whose primary address is not a contact's. */
    candidates: number;
    staff: number;
    system: number;
    /** Retired (soft-deleted) by this run. */
    retired: number;
    /** Left for a human: the point of contact of a deal, or with notes or tasks on them. */
    kept: { deals: number; notes: number; tasks: number };
}

/**
 * The workspace's live people whose primary address is not a contact's (`notAContactReason`): read a page at a
 * time, judged by the one rule the API applies on create and edit.
 */
export async function findNonContacts(rls: RlsPrismaService, workspaceId: string): Promise<NonContact[]> {
    const staff = await rls.withWorkspace(workspaceId, (tx) => staffAddresses(tx));
    const found: NonContact[] = [];
    let after: string | undefined;
    for (;;) {
        const page = await rls.withWorkspace(workspaceId, (tx) =>
            tx.person.findMany({
                where: { deletedAt: null, emailPrimary: { not: null } },
                select: { id: true, emailPrimary: true },
                orderBy: { id: 'asc' },
                take: PAGE,
                ...(after ? { cursor: { id: after }, skip: 1 } : {}),
            }),
        );
        for (const p of page) {
            if (!p.emailPrimary || notAContactReason(p.emailPrimary, staff) === null) continue;
            found.push({ id: p.id, kind: staff.has(p.emailPrimary.trim().toLowerCase()) ? 'staff' : 'system' });
        }
        if (page.length < PAGE) return found;
        after = page[page.length - 1]!.id;
    }
}

/**
 * Retires the workspace's non-contacts (#383) through the people service's own delete — `person.deleted`, which
 * the mail sync answers by matching their mail to no one and the contact-status consumer by re-deriving — a chunk
 * per transaction. One that is a deal's point of contact, or has notes or tasks on them, is kept and counted: a
 * human decides those. With `apply` false nothing is written.
 */
export async function retireNonContacts(
    app: INestApplicationContext,
    workspaceId: string,
    options: RetireOptions,
): Promise<RetireReport> {
    const rls = app.get(RlsPrismaService);
    const people = app.get(PeopleService);
    const events = app.get(DomainEvents);
    const chunk = options.chunk ?? DEFAULT_CHUNK;
    const context = systemContext(workspaceId);
    const candidates = await findNonContacts(rls, workspaceId);
    const report: RetireReport = {
        candidates: candidates.length,
        staff: candidates.filter((c) => c.kind === 'staff').length,
        system: candidates.filter((c) => c.kind === 'system').length,
        retired: 0,
        kept: { deals: 0, notes: 0, tasks: 0 },
    };
    for (let at = 0; at < candidates.length; at += chunk) {
        const batch = candidates.slice(at, at + chunk);
        await rls.withWorkspace(workspaceId, async (tx) => {
            for (const { id } of batch) {
                const [deals, notes, tasks] = await Promise.all([
                    tx.opportunity.count({ where: { pointOfContactId: id, deletedAt: null } }),
                    tx.noteTarget.count({ where: { targetType: 'person', targetId: id } }),
                    tx.taskTarget.count({ where: { targetType: 'person', targetId: id } }),
                ]);
                if (deals > 0) report.kept.deals += 1;
                else if (notes > 0) report.kept.notes += 1;
                else if (tasks > 0) report.kept.tasks += 1;
                else {
                    if (options.apply) {
                        const { event } = await people.removeIn(tx, context, id);
                        await events.record(tx, event);
                    }
                    report.retired += 1;
                }
            }
        });
        options.onProgress?.(
            `… ${Math.min(at + chunk, candidates.length)} of ${candidates.length} judged, ${report.retired} ${options.apply ? 'retired' : 'would retire'}`,
        );
    }
    return report;
}

/** The flags of a run, or `null` when they do not read. */
export function parseArgs(args: readonly string[]): { slug: string; options: RetireOptions } | null {
    const [slug, ...flags] = args;
    if (!slug || slug.startsWith('--')) return null;
    const options: RetireOptions = { apply: false };
    let mode: 'estimate' | 'apply' | undefined;
    for (let i = 0; i < flags.length; i++) {
        const flag = flags[i];
        if (flag === '--estimate' || flag === '--apply') {
            if (mode) return null;
            mode = flag === '--apply' ? 'apply' : 'estimate';
            options.apply = mode === 'apply';
        } else if (flag === '--chunk') {
            const n = Number(flags[++i]);
            if (!Number.isInteger(n) || n < 1) return null;
            options.chunk = n;
        } else {
            return null;
        }
    }
    return mode ? { slug, options } : null;
}

/**
 * `node dist/cli/retire-non-contacts.js <workspace-slug> --estimate|--apply [--chunk <n>]` — run on the server in its
 * own container (a `docker compose run`, so a deploy cannot stop it). Retires the people who are not contacts
 * (#383): colleagues and automated senders that an earlier system's auto-contacts, or an import, made people of.
 * Each retirement is a `person.deleted` the relay then delivers: their mail leaves the records, their contact status
 * is re-derived. `--estimate` changes nothing and prints what `--apply` would retire; `--chunk` the people per
 * transaction (`DEFAULT_CHUNK`). A run that stops partway is rerun as it was: it continues from the people still
 * live. Counts only: no address is printed.
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
        const report = await retireNonContacts(app, workspace.id, {
            ...parsed.options,
            onProgress: (line) => console.error(line),
        });
        const kept = `${report.kept.deals} kept as a deal's point of contact, ${report.kept.notes} with notes, ${report.kept.tasks} with tasks`;
        if (parsed.options.apply) {
            console.log(
                `retired: ${report.retired} of ${report.candidates} non-contacts (${report.staff} staff, ${report.system} automated senders); ${kept}`,
            );
        } else {
            console.log(
                `would retire: ${report.retired} of ${report.candidates} non-contacts (${report.staff} staff, ${report.system} automated senders); ${kept}`,
            );
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

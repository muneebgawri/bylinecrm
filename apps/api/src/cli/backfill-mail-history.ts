import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { PrismaService } from '../infra/prisma.service';
import { mapPool } from '../infra/map-pool';
import { parseFloor } from '../mail-sync/history-backfill';
import { MAIL_HISTORY_FLOOR_DEFAULT } from '../mail-sync/mail-sync.constants';
import { MailSyncService, type BackfillEstimate } from '../mail-sync/mail-sync.service';

const USAGE =
    'usage: node dist/cli/backfill-mail-history.js <workspace-slug> (--estimate | --apply) ' +
    '[--since YYYY-MM-DD] [--mailbox <address>] [--sample <n>] [--concurrency <n>]';

export interface BackfillCliArgs {
    slug: string;
    mode: 'estimate' | 'apply';
    since: string;
    mailbox: string | null;
    /** Estimate only: headers read per window at most; the rest counted at the share those matched at. */
    sample: number | null;
    /** Mailboxes walked at once (each has its own Gmail quota). */
    concurrency: number;
}

/** The CLI's arguments, or null when they are not a valid call. */
export function backfillCliArgs(argv: readonly string[]): BackfillCliArgs | null {
    const flags = new Map<string, string>();
    const positional: string[] = [];
    const modes: string[] = [];
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i]!;
        if (a === '--estimate' || a === '--apply') modes.push(a.slice(2));
        else if (a.startsWith('--')) {
            const value = argv[i + 1];
            if (value === undefined || value.startsWith('--')) return null;
            flags.set(a.slice(2), value);
            i += 1;
        } else positional.push(a);
    }
    const unknown = [...flags.keys()].filter((k) => !['since', 'mailbox', 'sample', 'concurrency'].includes(k));
    if (positional.length !== 1 || modes.length !== 1 || unknown.length > 0) return null;
    const count = (name: string, fallback: number | null): number | null | undefined => {
        const raw = flags.get(name);
        if (raw === undefined) return fallback;
        const n = Number(raw);
        return Number.isInteger(n) && n > 0 ? n : undefined;
    };
    const sample = count('sample', null);
    const concurrency = count('concurrency', 4);
    if (sample === undefined || concurrency === undefined || concurrency === null) return null;
    return {
        slug: positional[0]!,
        mode: modes[0] as 'estimate' | 'apply',
        since: flags.get('since') ?? MAIL_HISTORY_FLOOR_DEFAULT,
        mailbox: flags.get('mailbox')?.toLowerCase() ?? null,
        sample,
        concurrency,
    };
}

/**
 * `node dist/cli/backfill-mail-history.js <workspace-slug> (--estimate | --apply) [--since 2022-05-01]
 * [--mailbox <address>] [--sample <n>] [--concurrency <n>]` — the mail history backfill, run by the operator inside
 * the api container. Every connected Gmail mailbox of the workspace (or the one named) is walked back from where its
 * first import began to `--since` (default `MAIL_HISTORY_FLOOR_DEFAULT`, 2022-05-01), a month at a time, newest first, by the sync itself
 * (`MailSyncService.backfillStep`): what the mailbox already holds is skipped, the rest read as headers only, and only
 * a message with a person of the workspace in it is read whole and stored — on the timelines, counting toward contact
 * status, like any synced mail.
 *
 * - `--estimate` stores and writes nothing: per mailbox, the messages in the window, those already held, those that
 *   concern a person and would be stored, and their projected size at the database's current average stored message.
 *   `--sample <n>` reads at most n headers per window (cheaper on Gmail's quota) and counts the rest at their share.
 * - `--apply` sets each mailbox's floor and walks it to the end, `--concurrency` mailboxes at once (default 4). It
 *   stops, resumable, at `MAIL_BACKFILL_MAX_BYTES` stored over every workspace. A step cut short (a deploy, Gmail
 *   refusing) is repeated from its window's start; the worker's tick also carries on any backfill left running, so an
 *   interrupted run finishes on its own. Running it again resumes; a mailbox the worker is walking right now is left
 *   to it.
 *
 * Prints counts only — never a message, an address of a person or a subject.
 */
async function main(): Promise<void> {
    const args = backfillCliArgs(process.argv.slice(2));
    if (!args) throw new Error(USAGE);
    const floor = parseFloor(args.since);
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
        const owner = app.get(PrismaService);
        const sync = app.get(MailSyncService);
        const workspace = await owner.workspace.findUnique({ where: { slug: args.slug }, select: { id: true } });
        if (!workspace) throw new Error(`no workspace ${args.slug}`);
        const mailboxes = await owner.mailbox.findMany({
            where: {
                workspaceId: workspace.id,
                transport: 'gmail',
                status: 'connected',
                purpose: { not: 'service' },
                ...(args.mailbox ? { email: args.mailbox } : {}),
            },
            select: { id: true, email: true },
            orderBy: { email: 'asc' },
        });
        if (mailboxes.length === 0) throw new Error('no connected Gmail mailbox to backfill');
        console.log(`${mailboxes.length} mailbox(es); floor ${floor.toISOString().slice(0, 10)}; ${args.mode}`);
        if (args.mode === 'estimate') {
            await estimate(sync, workspace.id, mailboxes, floor, args);
        } else {
            await apply(sync, workspace.id, mailboxes, floor, args.concurrency);
        }
    } finally {
        await app.close();
    }
}

async function estimate(
    sync: MailSyncService,
    workspaceId: string,
    mailboxes: { id: string; email: string }[],
    floor: Date,
    args: BackfillCliArgs,
): Promise<void> {
    const average = await sync.averageStoredMessageBytes();
    const budget = await sync.backfillBudget();
    const columns = ['mailbox', 'from', 'windows', 'listed', 'held', 'headers', 'matched', 'would_store', 'projected'];
    console.log(columns.join('\t'));
    const results = await mapPool(mailboxes, args.concurrency, async (m) => {
        try {
            const e = await sync.estimateBackfill(workspaceId, m.id, floor, { sample: args.sample ?? undefined });
            if (!e) console.log(`${m.email}\t(first import not finished: skipped)`);
            else console.log(estimateLine(e, average));
            return e;
        } catch (error) {
            console.log(`${m.email}\tfailed: ${error instanceof Error ? error.message : String(error)}`);
            return null;
        }
    });
    const done = results.filter((e): e is BackfillEstimate => e !== null);
    const total = done.reduce(
        (t, e) => ({
            listed: t.listed + e.listed,
            held: t.held + e.alreadyStored,
            headers: t.headers + e.headersRead,
            store: t.store + e.wouldStore,
        }),
        { listed: 0, held: 0, headers: 0, store: 0 },
    );
    console.log(
        `total: listed ${total.listed}, already held ${total.held}, headers read ${total.headers}, ` +
            `would store ${total.store} ≈ ${gib(total.store * average)} at ${average} B per stored message`,
    );
    console.log(`budget: ${gib(budget.usedBytes)} used of ${gib(budget.maxBytes)} (MAIL_BACKFILL_MAX_BYTES)`);
}

function estimateLine(e: BackfillEstimate, average: number): string {
    return [
        e.email,
        e.from.toISOString().slice(0, 10),
        e.windows,
        e.listed,
        e.alreadyStored,
        e.headersRead,
        e.matched,
        e.wouldStore,
        gib(e.wouldStore * average),
    ].join('\t');
}

async function apply(
    sync: MailSyncService,
    workspaceId: string,
    mailboxes: { id: string; email: string }[],
    floor: Date,
    concurrency: number,
): Promise<void> {
    for (const m of mailboxes) await sync.startBackfill(workspaceId, m.id, floor);
    let failed = 0;
    let budgetReached = false;
    await mapPool(mailboxes, concurrency, async (m) => {
        for (;;) {
            if (budgetReached) return;
            try {
                const step = await sync.backfillStep(workspaceId, m.id);
                const w = step.window;
                const span = w ? `${w.after.toISOString().slice(0, 10)}..${w.before.toISOString().slice(0, 10)}` : '';
                console.log(
                    `${m.email}\t${step.outcome}\t${span}\tlisted ${step.progress.listed}\theld ${step.progress.alreadyStored}` +
                        `\tunmatched ${step.progress.unmatched}\timported ${step.progress.imported}`,
                );
                if (step.outcome === 'budget_reached') budgetReached = true;
                if (step.outcome !== 'walked') return;
            } catch (error) {
                failed += 1;
                console.log(`${m.email}\tfailed: ${error instanceof Error ? error.message : String(error)} (resumes)`);
                return;
            }
        }
    });
    const budget = await sync.backfillBudget();
    console.log(`budget: ${gib(budget.usedBytes)} used of ${gib(budget.maxBytes)}`);
    if (budgetReached) console.log('stopped at the budget: raise MAIL_BACKFILL_MAX_BYTES and run --apply again');
    if (failed > 0) process.exitCode = 1;
}

function gib(bytes: number): string {
    return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

if (require.main === module) {
    main().catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : error);
        process.exit(1);
    });
}

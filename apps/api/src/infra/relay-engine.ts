import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { PrismaService } from './prisma.service';
import type { WorkspaceContext } from './workspace-context';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The relay state every outbox table carries (P1-6, #93): `id`, `seq` (insertion order), `attempts`,
 * `next_attempt_at`, `lease_until`, `last_error`, `failed_at`, and one column that marks a row done.
 * A claimed row always has its id and the attempt this claim starts.
 */
export interface ClaimedBase {
    id: string;
    /** Including the attempt this claim starts. */
    attempts: number;
}

/** How a handler's work on one row went. It never throws: an unexpected throw counts as a failure. */
export type HandleResult<Extra> =
    { ok: true; extra?: Extra } | { ok: false; error: string; permanent?: boolean; extra?: Extra };

/** What the engine writes back for one row, besides releasing the claim. */
export type SettleState =
    | { outcome: 'completed'; at: Date }
    | { outcome: 'retrying'; nextAttemptAt: Date; lastError: string }
    | { outcome: 'failed'; at: Date; lastError: string };

/** How one row's delivery went, for the relay's bookkeeping and the tests. */
export type DeliveryOutcome = SettleState['outcome'];

/**
 * One outbox table and what to do with its rows. The engine owns everything that is the same for
 * every outbox — the claim, the lease, attempts and backoff, giving up, waking, polling, retention,
 * the background pool — and a relay supplies only this.
 */
export interface RelaySpec<Row extends ClaimedBase, Extra> {
    /** Names the relay in its logs: `outbox`, `mail outbox`. */
    name: string;
    /** The table (a constant identifier, never input), and the column that marks a row done. */
    table: string;
    doneColumn: string;
    /** The columns a claim returns besides `id` and `attempts`, as a SQL select list. */
    returning: string;
    /** Whether this process relays (the env flag): off, `kick` does nothing and no timer runs. */
    enabled: boolean;
    pollMs: number;
    batch: number;
    concurrency: number;
    leaseMs: number;
    maxAttempts: number;
    /** The wait before attempt `attempts + 1`, after `attempts` failed ones. */
    retryDelayMs(attempts: number): number;
    retention: { doneDays: number; failedDays: number; everyMs: number };
    /** The row's name in a log line: `outbox event <id> (<type>)`, `<kind> mail <key>`. */
    label(row: Row): string;
    /** Does the row's work. Runs on the background pool, with no transaction open. */
    handle(row: Row, now: Date): Promise<HandleResult<Extra>>;
    /** Writes `state` (and the handler's `extra`) for row `id`, releasing its lease. */
    settle(id: string, state: SettleState, extra: Extra | undefined): Promise<void>;
}

/**
 * The transactional-outbox relay, once (P1-6, #93): the domain-event relay and the mail relay both
 * run on it, so a fix to how rows are claimed, retried or kept lands in both.
 *
 * A scan claims open rows — not done, not failed, due, not held by a live claim — with
 * `FOR UPDATE SKIP LOCKED`, sets a lease and counts the attempt, in one short statement. Claims never
 * overlap, so several processes may relay one table at once. Each claimed row is handed to the
 * spec's handler, `concurrency` at a time, with no transaction open; the outcome is written in one
 * statement: done, a retry after the spec's doubling wait, or — on a permanent failure or past
 * `maxAttempts` — failed and kept for inspection. A relay that dies mid-delivery leaves its lease to
 * expire and the next scan claims the row again; handlers are idempotent on the row's id.
 *
 * A commit in this process wakes it (`kick`); a timer scans every `pollMs` for everything else —
 * retries come due, expired leases, rows another process committed — and once at start. Its passes
 * run detached from the caller's request (`WorkspaceContext.detached`), so their work is on the
 * background pool and never counted against a request. A retention pass deletes done and failed
 * rows past their days.
 */
export class RelayEngine<Row extends ClaimedBase, Extra = never> {
    private readonly logger: Logger;
    /** The pass loop in flight, if any. */
    private running: Promise<void> | null = null;
    /** A kick arrived while a pass loop ran: run another pass before stopping. */
    private kicked = false;
    private timers: NodeJS.Timeout[] = [];
    private stopped = false;

    constructor(
        private readonly spec: RelaySpec<Row, Extra>,
        private readonly ownerPrisma: PrismaService,
        private readonly context: WorkspaceContext,
        loggerName: string,
    ) {
        this.logger = new Logger(loggerName);
    }

    /** Starts the poll and retention timers and scans once, when the relay is enabled. */
    start(): void {
        if (!this.spec.enabled) return;
        this.timers.push(
            setInterval(() => this.kick(), this.spec.pollMs).unref(),
            setInterval(() => void this.pruneLogged(), this.spec.retention.everyMs).unref(),
        );
        // Once now: rows committed while no relay ran are delivered at start, not on the first tick.
        this.kick();
    }

    /** Stops the timers and lets deliveries in flight finish (an interrupted one would wait out its lease). */
    async stop(): Promise<void> {
        this.stopped = true;
        for (const timer of this.timers) clearInterval(timer);
        this.timers = [];
        await this.running;
    }

    /**
     * Wakes the relay: starts a pass loop, or asks the running one for another pass. Never throws
     * and never waits — it is called from a commit hook.
     */
    kick(): void {
        if (!this.spec.enabled || this.stopped) return;
        if (this.running) {
            this.kicked = true;
            return;
        }
        this.running = this.context
            .detached(() => this.loop())
            .finally(() => {
                this.running = null;
            });
    }

    /**
     * Delivers until nothing is due at `now()`, waiting for any pass already in flight. A test calls
     * it after a mutation to observe the effects (#89); it also works with the relay switched off.
     */
    async drain(now?: () => Date): Promise<void> {
        for (;;) {
            await this.running;
            const claimed = await this.context.detached(() => this.runOnce(now?.()));
            if (claimed === 0 && !this.running) return;
        }
    }

    /** One scan: claims what is due at `now` and delivers it. Returns how many rows it claimed. */
    async runOnce(now: Date = new Date()): Promise<number> {
        const claimed = await this.claim(now);
        for (let i = 0; i < claimed.length; i += this.spec.concurrency) {
            await Promise.all(claimed.slice(i, i + this.spec.concurrency).map((row) => this.deliver(row, now)));
        }
        return claimed.length;
    }

    /** Deletes done rows past their retention, and failed ones past theirs. Owner only. */
    async prune(now = Date.now()): Promise<{ done: number; failed: number }> {
        const table = Prisma.raw(this.spec.table);
        const doneColumn = Prisma.raw(this.spec.doneColumn);
        const done = await this.ownerPrisma.$executeRaw(Prisma.sql`
            DELETE FROM ${table} WHERE ${doneColumn} < ${new Date(now - this.spec.retention.doneDays * DAY_MS)}`);
        const failed = await this.ownerPrisma.$executeRaw(Prisma.sql`
            DELETE FROM ${table} WHERE failed_at < ${new Date(now - this.spec.retention.failedDays * DAY_MS)}`);
        return { done, failed };
    }

    private async loop(): Promise<void> {
        do {
            this.kicked = false;
            try {
                while (!this.stopped && (await this.runOnce()) > 0) {
                    // A full batch may mean more is due: scan again at once.
                }
            } catch (error) {
                // The scan itself failed (the database is unreachable); the next tick tries again.
                this.logger.error(`${this.spec.name} scan failed: ${describe(error)}`);
                return;
            }
        } while (this.kicked && !this.stopped);
    }

    private claim(now: Date): Promise<Row[]> {
        const table = Prisma.raw(this.spec.table);
        const doneColumn = Prisma.raw(this.spec.doneColumn);
        const leaseUntil = new Date(now.getTime() + this.spec.leaseMs);
        return this.ownerPrisma.$queryRaw<Row[]>(Prisma.sql`
            UPDATE ${table}
            SET lease_until = ${leaseUntil}, attempts = attempts + 1
            WHERE id IN (
                SELECT id FROM ${table}
                WHERE ${doneColumn} IS NULL AND failed_at IS NULL
                  AND (next_attempt_at IS NULL OR next_attempt_at <= ${now})
                  AND (lease_until IS NULL OR lease_until <= ${now})
                ORDER BY seq
                LIMIT ${this.spec.batch}
                FOR UPDATE SKIP LOCKED
            )
            RETURNING id, attempts, ${Prisma.raw(this.spec.returning)}`);
    }

    /** Runs the handler on one claimed row, then records how that went. */
    private async deliver(row: Row, now: Date): Promise<DeliveryOutcome> {
        let result: HandleResult<Extra>;
        try {
            result = await this.spec.handle(row, now);
        } catch (error) {
            result = { ok: false, error: describe(error) };
        }
        if (result.ok) {
            await this.spec.settle(row.id, { outcome: 'completed', at: new Date() }, result.extra);
            return 'completed';
        }
        const label = this.spec.label(row);
        if (result.permanent || row.attempts >= this.spec.maxAttempts) {
            await this.spec.settle(
                row.id,
                { outcome: 'failed', at: new Date(), lastError: result.error },
                result.extra,
            );
            this.logger.error(`${label} failed after ${row.attempts} attempts: ${result.error}`);
            return 'failed';
        }
        const nextAttemptAt = new Date(now.getTime() + this.spec.retryDelayMs(row.attempts));
        await this.spec.settle(row.id, { outcome: 'retrying', nextAttemptAt, lastError: result.error }, result.extra);
        this.logger.warn(
            `${label} attempt ${row.attempts} failed, retrying at ${nextAttemptAt.toISOString()}: ${result.error}`,
        );
        return 'retrying';
    }

    private async pruneLogged(): Promise<void> {
        try {
            const pruned = await this.prune();
            if (pruned.done + pruned.failed > 0) {
                this.logger.log(`pruned ${pruned.done} done and ${pruned.failed} failed ${this.spec.name} rows`);
            }
        } catch (error) {
            this.logger.error(`${this.spec.name} retention failed: ${describe(error)}`);
        }
    }
}

export function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

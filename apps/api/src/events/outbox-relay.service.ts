import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { Prisma } from '@prisma/client';
import type { DomainEvent } from '@bylinecrm/shared';
import { ENV, type Env } from '../config/env';
import { PrismaService } from '../infra/prisma.service';
import { WorkspaceContext } from '../infra/workspace-context';
import { OutboxConsumerOf, type OutboxConsumer } from './outbox-consumer';
import {
    OUTBOX_BATCH,
    OUTBOX_CONCURRENCY,
    OUTBOX_LEASE_MS,
    OUTBOX_MAX_ATTEMPTS,
    OUTBOX_POLL_MS,
    OUTBOX_RETENTION_DAYS,
    OUTBOX_RETENTION_EVERY_MS,
    outboxRetryDelayMs,
} from './outbox.constants';

const DAY_MS = 24 * 60 * 60 * 1000;

/** A consumer and the name its completions are stored under. */
interface NamedConsumer {
    name: string;
    consumer: OutboxConsumer;
}

/** An event one scan claimed. */
interface ClaimedRow {
    id: string;
    workspaceId: string;
    payload: DomainEvent;
    completedConsumers: string[];
    /** Including the attempt this claim starts. */
    attempts: number;
}

/** How one delivery went, for the relay's own bookkeeping and the tests. */
export type DeliveryOutcome = 'completed' | 'retrying' | 'failed';

/**
 * Delivers recorded domain events to the consumers (P1-6), at least once.
 *
 * A scan claims open events — not finished, not failed, due, not held by a live claim — with
 * `FOR UPDATE SKIP LOCKED`, sets a lease on them and counts the attempt, in one short statement.
 * It then hands each event to every consumer that accepts it and has not finished it yet, each in a
 * job scope (the background pool, never a request's), and writes the outcome: finished, a retry
 * after a doubling wait, or — past `OUTBOX_MAX_ATTEMPTS` — failed. A relay that dies mid-delivery
 * leaves its lease to expire; the next scan claims the event again. Consumers are idempotent on the
 * event id, so a second delivery writes nothing twice. Several processes may relay at once: claims
 * never overlap.
 *
 * It runs as the owner because it spans every workspace (like the webhook sweep); the consumers'
 * own writes go through `withWorkspace` in the event's workspace, under the policies.
 *
 * A commit in this process wakes it (`kick`); a timer scans every `OUTBOX_POLL_MS` for everything
 * else. `OUTBOX_RELAY=0` turns both off, for a process that should not deliver (compile-only runs).
 */
@Injectable()
export class OutboxRelay implements OnApplicationBootstrap, OnModuleDestroy {
    private readonly logger = new Logger(OutboxRelay.name);
    private consumers: NamedConsumer[] = [];
    /** The pass loop in flight, if any. */
    private running: Promise<void> | null = null;
    /** A kick arrived while a pass loop ran: run another pass before stopping. */
    private kicked = false;
    private timers: NodeJS.Timeout[] = [];
    private stopped = false;

    constructor(
        @Inject(ENV) private readonly env: Env,
        private readonly ownerPrisma: PrismaService,
        private readonly context: WorkspaceContext,
        private readonly discovery: DiscoveryService,
    ) {}

    onApplicationBootstrap(): void {
        this.consumers = this.discover();
        if (!this.env.OUTBOX_RELAY) return;
        this.timers.push(
            setInterval(() => this.kick(), OUTBOX_POLL_MS).unref(),
            setInterval(() => void this.pruneLogged(), OUTBOX_RETENTION_EVERY_MS).unref(),
        );
        // Once now: events committed while no relay ran are delivered at start, not on the first tick.
        this.kick();
    }

    async onModuleDestroy(): Promise<void> {
        this.stopped = true;
        for (const timer of this.timers) clearInterval(timer);
        this.timers = [];
        // Let deliveries in flight finish; an interrupted one would wait out its lease.
        await this.running;
    }

    /**
     * Wakes the relay: starts a pass loop, or asks the running one for another pass. Never throws
     * and never waits — it is called from a commit hook. The loop runs detached from the caller's
     * request, so its work is neither on the request pool nor counted against the request.
     */
    kick(): void {
        if (!this.env.OUTBOX_RELAY || this.stopped) return;
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
     * Delivers until nothing is due, waiting for any pass already in flight. A test calls it after
     * a mutation to observe the consumers' effects (#89); it also works with the relay switched off.
     */
    async drain(now?: () => Date): Promise<void> {
        for (;;) {
            await this.running;
            const claimed = await this.context.detached(() => this.runOnce(now?.()));
            if (claimed === 0 && !this.running) return;
        }
    }

    /** One scan: claims what is due at `now` and delivers it. Returns how many events it claimed. */
    async runOnce(now: Date = new Date()): Promise<number> {
        const claimed = await this.claim(now);
        for (let i = 0; i < claimed.length; i += OUTBOX_CONCURRENCY) {
            await Promise.all(claimed.slice(i, i + OUTBOX_CONCURRENCY).map((row) => this.deliver(row, now)));
        }
        return claimed.length;
    }

    /** Removes delivered events past their retention, and failed ones past theirs. Owner only: the app role cannot delete. */
    async prune(now = Date.now()): Promise<{ completed: number; failed: number }> {
        const completed = await this.ownerPrisma.outboxEvent.deleteMany({
            where: { completedAt: { lt: new Date(now - OUTBOX_RETENTION_DAYS.completed * DAY_MS) } },
        });
        const failed = await this.ownerPrisma.outboxEvent.deleteMany({
            where: { failedAt: { lt: new Date(now - OUTBOX_RETENTION_DAYS.failed * DAY_MS) } },
        });
        return { completed: completed.count, failed: failed.count };
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
                this.logger.error(`outbox scan failed: ${describe(error)}`);
                return;
            }
        } while (this.kicked && !this.stopped);
    }

    private async claim(now: Date): Promise<ClaimedRow[]> {
        const leaseUntil = new Date(now.getTime() + OUTBOX_LEASE_MS);
        return this.ownerPrisma.$queryRaw<ClaimedRow[]>(Prisma.sql`
            UPDATE outbox_events
            SET lease_until = ${leaseUntil}, attempts = attempts + 1
            WHERE id IN (
                SELECT id FROM outbox_events
                WHERE completed_at IS NULL AND failed_at IS NULL
                  AND (next_attempt_at IS NULL OR next_attempt_at <= ${now})
                  AND (lease_until IS NULL OR lease_until <= ${now})
                ORDER BY seq
                LIMIT ${OUTBOX_BATCH}
                FOR UPDATE SKIP LOCKED
            )
            RETURNING id, workspace_id AS "workspaceId", payload,
                      completed_consumers AS "completedConsumers", attempts`);
    }

    /** Hands one claimed event to every consumer still owed it, then records how that went. */
    private async deliver(row: ClaimedRow, now: Date): Promise<DeliveryOutcome> {
        const done = new Set(row.completedConsumers);
        const errors: string[] = [];
        for (const { name, consumer } of this.consumers) {
            if (done.has(name) || !consumer.accepts(row.payload)) continue;
            try {
                await this.context.run({ workspaceId: row.workspaceId, capabilities: new Set() }, () =>
                    consumer.consume({ id: row.id, event: row.payload }),
                );
                done.add(name);
            } catch (error) {
                errors.push(`${name}: ${describe(error)}`);
            }
        }
        const completedConsumers = [...done];
        if (errors.length === 0) {
            await this.settle(row.id, { completedConsumers, completedAt: new Date(), lastError: null });
            return 'completed';
        }
        const lastError = errors.join('; ');
        if (row.attempts >= OUTBOX_MAX_ATTEMPTS) {
            await this.settle(row.id, { completedConsumers, failedAt: new Date(), lastError });
            this.logger.error(
                `outbox event ${row.id} (${row.payload.type}) failed after ${row.attempts} attempts: ${lastError}`,
            );
            return 'failed';
        }
        const nextAttemptAt = new Date(now.getTime() + outboxRetryDelayMs(row.attempts));
        await this.settle(row.id, { completedConsumers, nextAttemptAt, lastError });
        this.logger.warn(
            `outbox event ${row.id} (${row.payload.type}) attempt ${row.attempts} failed, retrying at ${nextAttemptAt.toISOString()}: ${lastError}`,
        );
        return 'retrying';
    }

    /** Writes a delivery's outcome and releases the claim. */
    private async settle(id: string, data: Prisma.OutboxEventUpdateInput): Promise<void> {
        await this.ownerPrisma.outboxEvent.update({ where: { id }, data: { ...data, leaseUntil: null } });
    }

    private async pruneLogged(): Promise<void> {
        try {
            const pruned = await this.prune();
            if (pruned.completed + pruned.failed > 0) {
                this.logger.log(`pruned ${pruned.completed} delivered and ${pruned.failed} failed outbox events`);
            }
        } catch (error) {
            this.logger.error(`outbox retention failed: ${describe(error)}`);
        }
    }

    /** Every provider marked `@OutboxConsumerOf(name)`; two with one name is a programming error. */
    private discover(): NamedConsumer[] {
        const found: NamedConsumer[] = [];
        for (const wrapper of this.discovery.getProviders({ metadataKey: OutboxConsumerOf.KEY })) {
            const name = this.discovery.getMetadataByDecorator(OutboxConsumerOf, wrapper);
            if (!name || !wrapper.instance) continue;
            if (found.some((c) => c.name === name)) throw new Error(`two outbox consumers are named ${name}`);
            found.push({ name, consumer: wrapper.instance as OutboxConsumer });
        }
        return found.sort((a, b) => a.name.localeCompare(b.name));
    }
}

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

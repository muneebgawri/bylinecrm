import { Inject, Injectable, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import type { DomainEvent } from '@bylinecrm/shared';
import { ENV, type Env } from '../config/env';
import { PrismaService } from '../infra/prisma.service';
import { describe, RelayEngine, type ClaimedBase, type HandleResult, type SettleState } from '../infra/relay-engine';
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

export type { DeliveryOutcome } from '../infra/relay-engine';

/** A consumer and the name its completions are stored under. */
interface NamedConsumer {
    name: string;
    consumer: OutboxConsumer;
}

/** An event one scan claimed. */
interface ClaimedRow extends ClaimedBase {
    workspaceId: string;
    payload: DomainEvent;
    completedConsumers: string[];
}

/** What a delivery writes besides its outcome: the consumers that have finished the event. */
interface DeliveryExtra {
    completedConsumers: string[];
}

/**
 * Delivers recorded domain events to the consumers (P1-6), at least once, on the shared relay
 * engine (`RelayEngine`): claims with `FOR UPDATE SKIP LOCKED` and a lease, retries with a doubling
 * wait, gives up past `OUTBOX_MAX_ATTEMPTS`, wakes on a local commit and polls every
 * `OUTBOX_POLL_MS`, keeps rows for `OUTBOX_RETENTION_DAYS`.
 *
 * What is this relay's own: each claimed event goes to every consumer that accepts it and has not
 * finished it yet, each in a job scope in the event's workspace (the background pool, never a
 * request's); the consumers that finished are stored, so a retry runs only the others. Consumers are
 * idempotent on the event id. It runs as the owner because it spans every workspace; the consumers'
 * own writes go through `withWorkspace` under the policies. `OUTBOX_RELAY=0` turns the wake-ups and
 * timers off, for a process that should not deliver (compile-only runs).
 */
@Injectable()
export class OutboxRelay implements OnApplicationBootstrap, OnModuleDestroy {
    private consumers: NamedConsumer[] = [];
    private readonly engine: RelayEngine<ClaimedRow, DeliveryExtra>;

    constructor(
        @Inject(ENV) env: Env,
        private readonly ownerPrisma: PrismaService,
        private readonly context: WorkspaceContext,
        private readonly discovery: DiscoveryService,
    ) {
        this.engine = new RelayEngine<ClaimedRow, DeliveryExtra>(
            {
                name: 'outbox',
                table: 'outbox_events',
                doneColumn: 'completed_at',
                returning: 'workspace_id AS "workspaceId", payload, completed_consumers AS "completedConsumers"',
                enabled: env.OUTBOX_RELAY,
                pollMs: OUTBOX_POLL_MS,
                batch: OUTBOX_BATCH,
                concurrency: OUTBOX_CONCURRENCY,
                leaseMs: OUTBOX_LEASE_MS,
                maxAttempts: OUTBOX_MAX_ATTEMPTS,
                retryDelayMs: outboxRetryDelayMs,
                retention: {
                    doneDays: OUTBOX_RETENTION_DAYS.completed,
                    failedDays: OUTBOX_RETENTION_DAYS.failed,
                    everyMs: OUTBOX_RETENTION_EVERY_MS,
                },
                label: (row) => `outbox event ${row.id} (${row.payload.type})`,
                handle: (row) => this.deliver(row),
                settle: (id, state, extra) => this.settle(id, state, extra),
            },
            ownerPrisma,
            context,
            OutboxRelay.name,
        );
    }

    onApplicationBootstrap(): void {
        this.consumers = this.discover();
        this.engine.start();
    }

    onModuleDestroy(): Promise<void> {
        return this.engine.stop();
    }

    /** Wakes the relay; never throws and never waits — it is called from a commit hook. */
    kick(): void {
        this.engine.kick();
    }

    /**
     * Delivers until nothing is due, waiting for any pass already in flight. A test calls it after
     * a mutation to observe the consumers' effects (#89); it also works with the relay switched off.
     */
    drain(now?: () => Date): Promise<void> {
        return this.engine.drain(now);
    }

    /** One scan: claims what is due at `now` and delivers it. Returns how many events it claimed. */
    runOnce(now?: Date): Promise<number> {
        return this.engine.runOnce(now);
    }

    /** Removes delivered events past their retention, and failed ones past theirs. Owner only: the app role cannot delete. */
    async prune(now = Date.now()): Promise<{ completed: number; failed: number }> {
        const { done, failed } = await this.engine.prune(now);
        return { completed: done, failed };
    }

    /** Hands one claimed event to every consumer still owed it. */
    private async deliver(row: ClaimedRow): Promise<HandleResult<DeliveryExtra>> {
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
        const extra = { completedConsumers: [...done] };
        return errors.length === 0 ? { ok: true, extra } : { ok: false, error: errors.join('; '), extra };
    }

    /** Writes a delivery's outcome and the consumers that finished, and releases the claim. */
    private async settle(id: string, state: SettleState, extra: DeliveryExtra | undefined): Promise<void> {
        const outcome =
            state.outcome === 'completed'
                ? { completedAt: state.at, lastError: null }
                : state.outcome === 'failed'
                  ? { failedAt: state.at, lastError: state.lastError }
                  : { nextAttemptAt: state.nextAttemptAt, lastError: state.lastError };
        await this.ownerPrisma.outboxEvent.update({
            where: { id },
            data: { ...outcome, ...(extra ?? {}), leaseUntil: null },
        });
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

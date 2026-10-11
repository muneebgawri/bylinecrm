import type { INestApplicationContext } from '@nestjs/common';
import type { DomainEvent } from '@bylinecrm/shared';
import { OutboxRelay } from '../../src/events/outbox-relay.service';
import { PrismaService } from '../../src/infra/prisma.service';

/**
 * The cross-tenant suite's two views of domain events (P1-6, #89).
 *
 * A mutation records its event in its own transaction, so what was recorded is readable the moment
 * the request returns: `eventLog` reads the outbox. What the consumers do with an event — timeline
 * entries, webhook deliveries, stage-rule moves, mail re-matching — happens after the commit, when
 * the relay delivers it: `settle` waits for that. Every assertion on a consumer's effect after a
 * mutation calls `settle` first; none sleeps or polls.
 */

/**
 * Waits until every recorded event that is due has been delivered to every consumer. An event a
 * consumer failed is not due until its retry time, so a test of failure sees it still open.
 */
export async function settle(app: INestApplicationContext): Promise<void> {
    await app.get(OutboxRelay).drain();
}

/**
 * The events recorded from the moment the log was made (or last `reset`), in recording order,
 * that match one of the patterns: an exact type (`email.replied`), every type of one object
 * (`person.*`), or every type (`**`).
 */
export class EventLog {
    private constructor(
        private readonly owner: PrismaService,
        private readonly patterns: readonly string[],
        private from: bigint,
    ) {}

    static async open(app: INestApplicationContext, patterns: readonly string[]): Promise<EventLog> {
        const owner = app.get(PrismaService);
        return new EventLog(owner, patterns, await latestSeq(owner));
    }

    /** Forgets what was recorded so far; later reads see only what is recorded after this. */
    async reset(): Promise<void> {
        this.from = await latestSeq(this.owner);
    }

    async read(): Promise<DomainEvent[]> {
        const rows = await this.owner.outboxEvent.findMany({
            where: { seq: { gt: this.from } },
            orderBy: { seq: 'asc' },
            select: { payload: true },
        });
        return rows.map((row) => row.payload as unknown as DomainEvent).filter((event) => this.matches(event.type));
    }

    private matches(type: string): boolean {
        return this.patterns.some(
            (pattern) =>
                pattern === '**' ||
                pattern === type ||
                (pattern.endsWith('.*') && type.startsWith(pattern.slice(0, -1))),
        );
    }
}

/** Opens an `EventLog` over the patterns, starting now. */
export function eventLog(app: INestApplicationContext, ...patterns: string[]): Promise<EventLog> {
    return EventLog.open(app, patterns);
}

async function latestSeq(owner: PrismaService): Promise<bigint> {
    const latest = await owner.outboxEvent.aggregate({ _max: { seq: true } });
    return latest._max.seq ?? 0n;
}

import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { RlsPrismaService } from '../infra/rls-prisma.service';
import { type Page, paginate } from '../records/list-query';
import type { ServiceMailMessage, SentCountsView } from './responses';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * What an integration may read of synced mail (SVC-1, owner 2026-10-24). NewswireOS reads partner confirmations
 * (Korewire, ACN, FinanceWire) and counts its staff's sent mail here, where it used to read Twenty's.
 *
 * - `serviceMessages` — every message a service inbox holds (media@, pr@), bodies included, ordered by when the CRM
 *   stored it (monotonic, unlike the sender-controlled Date header), optionally only from named senders. Mail that
 *   only a member's personal mailbox holds is never here: a person's mailbox is theirs (`mail:service_read`).
 * - `sentCounts` — how many messages each named sender sent on one UTC day: counts and the last send time, never a
 *   body or a recipient. Only mail already sent: a Gmail scheduled send is stored when it is scheduled, stamped with
 *   the time it will go, and counts on that day once that time has passed — never before (`mail:sent_counts`).
 */
@Injectable()
export class IntegrationMailService {
    constructor(private readonly rls: RlsPrismaService) {}

    serviceMessages(input: {
        from?: readonly string[] | undefined;
        since: Date;
        until?: Date | undefined;
        cursor?: string | undefined;
        limit: number;
    }): Promise<Page<ServiceMailMessage>> {
        return this.rls.withWorkspace(async (tx) => {
            const where: Prisma.MailMessageWhereInput = {
                copies: { some: { mailbox: { purpose: 'service' } } },
                createdAt: { gte: input.since, ...(input.until ? { lt: input.until } : {}) },
                ...(input.from ? { fromAddress: { in: [...input.from] } } : {}),
            };
            const page = await paginate(input.limit, input.cursor, (args) =>
                tx.mailMessage.findMany({
                    where,
                    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
                    select: {
                        id: true,
                        fromAddress: true,
                        subject: true,
                        bodyText: true,
                        sentAt: true,
                        createdAt: true,
                    },
                    ...args,
                }),
            );
            return {
                nextCursor: page.nextCursor,
                items: page.items.map((m) => ({
                    id: m.id,
                    from: m.fromAddress.toLowerCase(),
                    subject: m.subject,
                    text: m.bodyText,
                    sentAt: m.sentAt,
                    storedAt: m.createdAt,
                })),
            };
        });
    }

    sentCounts(input: { from: readonly string[]; day: string }, now: Date = new Date()): Promise<SentCountsView> {
        const start = new Date(`${input.day}T00:00:00.000Z`);
        const end = new Date(start.getTime() + DAY_MS);
        // Sent by now: a scheduled send waiting for its time is stored with that time, and is not sent yet.
        const until = end < now ? end : now;
        return this.rls.withWorkspace(async (tx) => {
            const rows =
                until <= start
                    ? []
                    : await tx.$queryRaw<{ address: string; count: bigint; last_sent_at: Date }[]>`
                        SELECT lower(m.from_address) AS address, count(*) AS count, max(m.sent_at) AS last_sent_at
                          FROM mail_messages m
                         WHERE m.direction = 'outbound'
                           AND lower(m.from_address) = ANY(${[...input.from]}::text[])
                           AND m.sent_at >= ${start} AND m.sent_at < ${until}
                         GROUP BY 1
                         ORDER BY 1`;
            return {
                day: input.day,
                complete: end <= now,
                senders: rows.map((r) => ({ address: r.address, count: Number(r.count), lastSentAt: r.last_sent_at })),
            };
        });
    }
}

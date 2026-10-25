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
 * - `sentCounts` — how many messages each named sender sent on one UTC day, or over a range of days: counts and the
 *   last send time, and how much of it reached customers and how much prospects (PNW-926) — messages and distinct
 *   people, never a body or a recipient. Only mail already sent: a Gmail scheduled send is stored when it is scheduled, stamped with
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

    sentCounts(
        input: { from: readonly string[]; day: string; through?: string | undefined },
        now: Date = new Date(),
    ): Promise<SentCountsView> {
        const through = input.through ?? input.day;
        const start = new Date(`${input.day}T00:00:00.000Z`);
        const end = new Date(new Date(`${through}T00:00:00.000Z`).getTime() + DAY_MS);
        // Sent by now: a scheduled send waiting for its time is stored with that time, and is not sent yet.
        const until = end < now ? end : now;
        return this.rls.withWorkspace(async (tx) => {
            // Each recipient (to, cc, bcc) is in one audience (PNW-926). A colleague is neither, whatever else is true
            // of their address; a customer is a live outreach exclusion — every exclusion is a customer: a NewswireOS
            // client or a won deal, by address or by domain — or a person whose contact status is Customer; a prospect
            // is any other person the CRM has. A message counts once for each audience it reached; a person once over
            // the whole range.
            const rows =
                until <= start
                    ? []
                    : await tx.$queryRaw<
                          {
                              address: string;
                              count: bigint;
                              last_sent_at: Date;
                              customer_messages: bigint;
                              customer_people: bigint;
                              prospect_messages: bigint;
                              prospect_people: bigint;
                          }[]
                      >`
                        WITH sent AS (
                            SELECT m.id, lower(m.from_address) AS sender, m.sent_at
                              FROM mail_messages m
                             WHERE m.direction = 'outbound'
                               AND lower(m.from_address) = ANY(${[...input.from]}::text[])
                               AND m.sent_at >= ${start} AND m.sent_at < ${until}
                        ), reached AS (
                            SELECT p.message_id,
                                   coalesce(p.person_id::text, p.address) AS who,
                                   CASE
                                       WHEN p.member_id IS NOT NULL THEN NULL
                                       WHEN pe.contact_status = 'customer'
                                         OR EXISTS (SELECT 1 FROM outreach_exclusions e
                                                     WHERE e.removed_at IS NULL
                                                       AND (e.address = p.address OR e.domain = split_part(p.address, '@', 2)))
                                           THEN 'customer'
                                       WHEN p.person_id IS NOT NULL THEN 'prospect'
                                   END AS audience
                              FROM mail_participants p
                              LEFT JOIN people pe ON pe.id = p.person_id
                             WHERE p.message_id IN (SELECT id FROM sent) AND p.role IN ('to', 'cc', 'bcc')
                        )
                        SELECT s.sender AS address,
                               count(DISTINCT s.id) AS count,
                               max(s.sent_at) AS last_sent_at,
                               count(DISTINCT r.message_id) FILTER (WHERE r.audience = 'customer') AS customer_messages,
                               count(DISTINCT r.who) FILTER (WHERE r.audience = 'customer') AS customer_people,
                               count(DISTINCT r.message_id) FILTER (WHERE r.audience = 'prospect') AS prospect_messages,
                               count(DISTINCT r.who) FILTER (WHERE r.audience = 'prospect') AS prospect_people
                          FROM sent s
                          LEFT JOIN reached r ON r.message_id = s.id
                         GROUP BY 1
                         ORDER BY 1`;
            return {
                day: input.day,
                through,
                complete: end <= now,
                senders: rows.map((r) => ({
                    address: r.address,
                    count: Number(r.count),
                    lastSentAt: r.last_sent_at,
                    customers: { messages: Number(r.customer_messages), people: Number(r.customer_people) },
                    prospects: { messages: Number(r.prospect_messages), people: Number(r.prospect_people) },
                })),
            };
        });
    }
}

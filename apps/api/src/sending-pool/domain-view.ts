import type { Prisma } from '@prisma/client';
import {
    SENDING_DOMAIN_USES,
    SPAM_RATE_HISTORY_DAYS,
    type DomainCheck,
    type SendingDomainUse,
    type SendingDomainView,
} from '@bylinecrm/shared';
import type { WorkspaceClient } from '../infra/rls-prisma.service';
import { sendingDomainOf } from './pool-mailbox';
import { postmasterRange } from './postmaster.http';

/**
 * A sending domain is read with its latest Postmaster Tools rates (#129, #190): the newest
 * `sending_domain_stats` rows by day — a failed lookup keeps them, so the view never shows a zero
 * for "could not read".
 */
export const DOMAIN_WITH_RATE = {
    include: { stats: { orderBy: { day: 'desc' }, take: SPAM_RATE_HISTORY_DAYS } },
} satisfies Prisma.SendingDomainDefaultArgs;

export type DomainRow = Prisma.SendingDomainGetPayload<typeof DOMAIN_WITH_RATE>;

/** What uses each domain (#190): the purposes of the workspace's connected mailboxes on it, derived, never stored. */
export type DomainUses = Map<string, SendingDomainUse[]>;

export async function domainUsesIn(tx: WorkspaceClient): Promise<DomainUses> {
    const mailboxes = await tx.mailbox.findMany({
        where: { status: { not: 'disconnected' } },
        select: { email: true, purpose: true },
    });
    const uses: DomainUses = new Map();
    for (const m of mailboxes) {
        const domain = sendingDomainOf(m.email);
        const seen = new Set([...(uses.get(domain) ?? []), m.purpose]);
        uses.set(
            domain,
            SENDING_DOMAIN_USES.filter((u) => seen.has(u)),
        );
    }
    return uses;
}

export function domainView(row: DomainRow, uses: DomainUses, now = new Date()): SendingDomainView {
    const latest = row.stats[0];
    const { from } = postmasterRange(now);
    const usedBy = uses.get(row.domain) ?? [];
    return {
        id: row.id,
        domain: row.domain,
        dkimSelector: row.dkimSelector,
        status: row.status,
        lastCheck: (row.lastCheck as unknown as DomainCheck | null) ?? null,
        checkedAt: row.checkedAt?.toISOString() ?? null,
        nextCheckAt: row.nextCheckAt.toISOString(),
        usedBy,
        gated: usedBy.includes('pool'),
        inPostmaster: row.inPostmaster,
        spamRate: latest ? { day: dayOf(latest.day), rateBps: latest.spamRateBps } : null,
        spamRates: row.stats
            .map((s) => ({ day: dayOf(s.day), rateBps: s.spamRateBps }))
            .filter((s) => s.day >= from)
            .reverse(),
        postmaster: {
            status: row.postmasterStatus,
            message: row.postmasterMessage,
            readAt: row.postmasterReadAt?.toISOString() ?? null,
            nextReadAt: row.postmasterNextReadAt?.toISOString() ?? null,
        },
    };
}

function dayOf(day: Date): string {
    return day.toISOString().slice(0, 10);
}

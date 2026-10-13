import type { Prisma } from '@prisma/client';
import type { DomainCheck, SendingDomainView } from '@bylinecrm/shared';

/**
 * A sending domain is read with its latest Postmaster Tools rate (#129): the newest `sending_domain_stats`
 * row by day — a failed lookup keeps it, so the view never shows a zero for "could not read".
 */
export const DOMAIN_WITH_RATE = {
    include: { stats: { orderBy: { day: 'desc' }, take: 1 } },
} satisfies Prisma.SendingDomainDefaultArgs;

export type DomainRow = Prisma.SendingDomainGetPayload<typeof DOMAIN_WITH_RATE>;

export function domainView(row: DomainRow): SendingDomainView {
    const latest = row.stats[0];
    return {
        id: row.id,
        domain: row.domain,
        dkimSelector: row.dkimSelector,
        status: row.status,
        lastCheck: (row.lastCheck as unknown as DomainCheck | null) ?? null,
        checkedAt: row.checkedAt?.toISOString() ?? null,
        nextCheckAt: row.nextCheckAt.toISOString(),
        spamRate: latest ? { day: latest.day.toISOString().slice(0, 10), rateBps: latest.spamRateBps } : null,
        postmaster: { status: row.postmasterStatus, message: row.postmasterMessage },
    };
}

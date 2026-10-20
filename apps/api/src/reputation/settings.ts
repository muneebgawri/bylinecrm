import { REPUTATION_DEFAULTS, type ReputationSettings } from '@bylinecrm/shared';
import type { ReputationSettings as Row } from '@prisma/client';
import type { WorkspaceClient } from '../infra/rls-prisma.service';

/** The workspace's sender-reputation thresholds (REP-1), or the defaults while it has set none. */
export async function reputationSettingsIn(tx: WorkspaceClient): Promise<ReputationSettings> {
    const row = await tx.reputationSettings.findFirst();
    return row ? pickReputationSettings(row) : { ...REPUTATION_DEFAULTS };
}

/**
 * The workspace's primary domain (REP-1): the admin's choice, or else the domain most current members sign in
 * with (ties: alphabetical). Null for a workspace with no members on a domain.
 */
export async function primaryDomainIn(tx: WorkspaceClient, settings: ReputationSettings): Promise<string | null> {
    if (settings.primaryDomain) return settings.primaryDomain;
    return derivedPrimaryDomainIn(tx);
}

export async function derivedPrimaryDomainIn(tx: WorkspaceClient): Promise<string | null> {
    const members = await tx.workspaceMember.findMany({
        where: { leftAt: null },
        select: { user: { select: { email: true } } },
    });
    const counts = new Map<string, number>();
    for (const m of members) {
        const email = m.user.email.toLowerCase();
        const at = email.lastIndexOf('@');
        if (at < 0) continue;
        const domain = email.slice(at + 1);
        counts.set(domain, (counts.get(domain) ?? 0) + 1);
    }
    let best: [string, number] | null = null;
    for (const [domain, n] of counts) {
        if (!best || n > best[1] || (n === best[1] && domain < best[0])) best = [domain, n];
    }
    return best?.[0] ?? null;
}

export function pickReputationSettings(row: Row): ReputationSettings {
    return {
        dailyNewRecipients: row.dailyNewRecipients,
        hourlyNewRecipients: row.hourlyNewRecipients,
        poolHourlyCap: row.poolHourlyCap,
        nearDuplicateThreshold: row.nearDuplicateThreshold,
        nearDuplicateDistance: row.nearDuplicateDistance,
        subjectRepeatThreshold: row.subjectRepeatThreshold,
        primaryDomain: row.primaryDomain,
    };
}

import { REPUTATION_DEFAULTS, type ReputationSettings } from '@bylinecrm/shared';
import type { ReputationSettings as Row } from '@prisma/client';
import type { WorkspaceClient } from '../infra/rls-prisma.service';

/** The workspace's sender-reputation thresholds (REP-1), or the defaults while it has set none. */
export async function reputationSettingsIn(tx: WorkspaceClient): Promise<ReputationSettings> {
    const row = await tx.reputationSettings.findFirst();
    return row ? pickReputationSettings(row) : { ...REPUTATION_DEFAULTS };
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
        replyRateFloorBps: row.replyRateFloorBps,
        replyRateMinSends: row.replyRateMinSends,
        replyRateWindowDays: row.replyRateWindowDays,
        spamPauseBps: row.spamPauseBps,
        spamWarnBps: row.spamWarnBps,
    };
}

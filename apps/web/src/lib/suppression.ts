import type { SuppressionReason } from '@bylinecrm/shared';

/** A suppression's reason as people read it: the settings list's badge and the timeline's chip (#114). */
export const SUPPRESSION_REASON_LABEL: Readonly<Record<SuppressionReason, string>> = {
    unsubscribe: 'Unsubscribed',
    hard_bounce: 'Hard bounce',
    complaint: 'Spam complaint',
    manual: 'Manual',
};

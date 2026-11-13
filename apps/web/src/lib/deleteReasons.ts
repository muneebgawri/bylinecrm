import type { DeleteReason } from '@bylinecrm/shared';

/** Why a record is deleted, as the delete dialog offers it and the trash shows it. */
export const DELETE_REASON_LABEL: Record<DeleteReason, string> = {
    not_a_lead: 'Not a lead',
    duplicate: 'Duplicate',
    wrong_details: 'Wrong details',
    other: 'Other',
};

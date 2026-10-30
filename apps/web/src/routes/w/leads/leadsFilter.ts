import type { ContactStatus } from '@bylinecrm/shared';
import type { Tone } from '@bylinecrm/ui';
import { encodeFilter } from '../../../lib/filterParam';

/** The people list narrowed to the statuses that are still leads, as the URL carries it. */
export const LEADS_FILTER = encodeFilter({
    and: [{ field: 'contactStatus', op: 'in', value: ['new', 'attempted_contact', 'contacted', 'engaged'] }],
});

/** The colour each contact status wears, on a pill in a list and on a lane of the lead pipeline. */
export const CONTACT_STATUS_TONE: Record<ContactStatus, Tone> = {
    new: 'neutral',
    attempted_contact: 'info',
    contacted: 'accent',
    engaged: 'success',
    unresponsive: 'warning',
    do_not_contact: 'danger',
    customer: 'success',
};

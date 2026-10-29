import { encodeFilter } from '../../../lib/filterParam';

/** The people list narrowed to the statuses that are still leads, as the URL carries it. */
export const LEADS_FILTER = encodeFilter({
    and: [{ field: 'contactStatus', op: 'in', value: ['new', 'attempted_contact', 'contacted', 'engaged'] }],
});

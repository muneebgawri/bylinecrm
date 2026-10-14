import { SENDING_DOMAIN_RECHECK_MS, type PostmasterDomainStatus } from '@bylinecrm/shared';

/** The longest a rate limit's backoff waits: Google's quota is daily. */
const POSTMASTER_BACKOFF_MAX_MS = 24 * 60 * 60 * 1000;

/**
 * When a domain's check asks Postmaster Tools again (#183), from what the last ask came to:
 *
 * - `ok` — the day's reading is in (the data is daily): the next UTC day, so an on-demand check
 *   never asks more than once per domain per day.
 * - `rate_limited` — Google's quota said not now: its Retry-After when it gave one, else the
 *   check's cadence doubled per consecutive limit (`limitedBefore`), at most a day.
 * - anything else that answered or did not (`unreachable`, `failed`, `not_verified`): the check's
 *   cadence, as the next scheduled check would.
 * - `not_connected` — nothing to ask: null, and the first check after connecting asks at once.
 */
export function nextPostmasterReadAt(
    reading: { status: PostmasterDomainStatus; retryAfterS?: number | null },
    now: Date,
    limitedBefore: number,
): Date | null {
    switch (reading.status) {
        case 'not_connected':
            return null;
        case 'ok':
            return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
        case 'rate_limited': {
            if (reading.retryAfterS !== null && reading.retryAfterS !== undefined) {
                return new Date(now.getTime() + reading.retryAfterS * 1000);
            }
            const backoff = Math.min(SENDING_DOMAIN_RECHECK_MS * 2 ** limitedBefore, POSTMASTER_BACKOFF_MAX_MS);
            return new Date(now.getTime() + backoff);
        }
        default:
            return new Date(now.getTime() + SENDING_DOMAIN_RECHECK_MS);
    }
}

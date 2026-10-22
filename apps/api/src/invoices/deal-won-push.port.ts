import type { NewswireosLink } from './newswireos-verification.port';

/**
 * PNW-766 (doc 11 §8s): the CRM telling NewswireOS a deal was won, so its contact becomes a client with the deal
 * owner's account manager. One port; the HTTP adapter and the tests' fake implement it. A refusal or no answer is
 * thrown as a `NewswireosApiError` (`status` null for no answer).
 */

/** `POST /api/v1/crm/deal-won`, in NewswireOS's wire format. Sent only for a deal whose contact has an email. */
export interface DealWonBody {
    /** The `deal.won` event's id: NewswireOS answers a redelivery as it answered the first. */
    event_id: string;
    /** ISO 8601. */
    occurred_at: string;
    deal: { byline_id: string; name: string; amount_minor?: number; currency?: string };
    company: { byline_id: string; name: string; domain?: string };
    contact: { byline_id: string; email: string; name?: string };
    owner: { email: string };
}

/**
 * NewswireOS's `200 {customer_id, reason_code, am_reason_code, parent_customer_id?}`. `reason_code` is `CREATED`,
 * `LINKED`, `COLLEAGUE` (the company was already a client: `parent_customer_id` is it), `AGENCY_CLIENT` or
 * `NOT_A_CLIENT` (a staff address; `customer_id` null, nothing written). `am_reason_code` is the ownership push's:
 * `REASSIGNED`, `UNCHANGED`, `NO_AM_FOR_EMAIL` or `AGENCY_CLIENT`.
 */
export interface DealWonAnswer {
    customerId: string | null;
    parentCustomerId: string | null;
    reasonCode: string | null;
    amReasonCode: string | null;
}

export interface NewswireosDealWonPort {
    push(link: NewswireosLink, body: DealWonBody): Promise<DealWonAnswer>;
}

export const NEWSWIREOS_DEAL_WON_PORT = Symbol('NEWSWIREOS_DEAL_WON_PORT');

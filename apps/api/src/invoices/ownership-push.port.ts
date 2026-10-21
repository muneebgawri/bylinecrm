import type { NewswireosLink } from './newswireos-verification.port';

/**
 * PNW-765: the CRM telling NewswireOS a record changed hands, so NewswireOS's account manager follows the CRM's
 * owner. One port; the HTTP adapter and the tests' fake implement it. A refusal or no answer is thrown as a
 * `NewswireosApiError` (`status` null for no answer).
 */

/** `POST /api/v1/crm/ownership-changed`, in NewswireOS's wire format. */
export interface OwnershipChangedBody {
    /** The `transfer.completed` event's id: NewswireOS dedupes on it. */
    event_id: string;
    /** ISO 8601. */
    occurred_at: string;
    record_type: 'person' | 'company';
    record: {
        byline_id: string;
        /** The person's addresses, or the company's people's; never empty. */
        emails: string[];
        domain?: string;
        /** Absent when the record has none. */
        name?: string;
    };
    previous_owner: { email: string } | null;
    new_owner: { email: string };
    /** `transfer`: accepted by the receiver. `forced`: moved by a manager. `first_contact`: a lead handed to its company's owner. */
    reason: 'transfer' | 'forced' | 'first_contact';
    forced: boolean;
}

/** One NewswireOS client the change touched: `REASSIGNED`, `UNCHANGED` or `AGENCY_CLIENT`. */
export interface OwnershipPushCustomer {
    customerId: string;
    reasonCode: string | null;
}

/**
 * NewswireOS's `200 {matched, reason_code, customers: [{customer_id, reason_code}]}`. The top-level code is one of
 * `NO_AM_FOR_EMAIL`, `STALE` (an older change than one it already applied), `NO_CUSTOMER`, `REASSIGNED`,
 * `UNCHANGED`, `AGENCY_CLIENT`.
 */
export interface OwnershipPushAnswer {
    matched: boolean;
    customers: OwnershipPushCustomer[];
    reasonCode: string | null;
}

export interface NewswireosOwnershipPort {
    push(link: NewswireosLink, body: OwnershipChangedBody): Promise<OwnershipPushAnswer>;
}

export const NEWSWIREOS_OWNERSHIP_PORT = Symbol('NEWSWIREOS_OWNERSHIP_PORT');

import type { RecordObject, RecordTarget } from './records.js';
import type { LabelledTarget } from './notifications.js';

/**
 * Ownership transfers (OWN-1, FR-CRMS-17): the one way a record changes hands. An owner proposes a
 * transfer to another member, who accepts or declines; a holder of `record:transfer` (the `manager`
 * system role, admins) moves a record at once, and the transfer records that it was forced. Either
 * way, what moves is the record's whole unit — a company with its people and open deals — so a lead
 * and its deal never end up with different owners.
 */

export const TRANSFER_STATUSES = ['proposed', 'accepted', 'declined', 'cancelled', 'forced'] as const;
export type TransferStatus = (typeof TRANSFER_STATUSES)[number];

/** A transfer that changed owners: the receiver accepted it, or a manager forced it. */
export const COMPLETED_TRANSFER_STATUSES: readonly TransferStatus[] = ['accepted', 'forced'];

export interface TransferMember {
    memberId: string;
    name: string | null;
}

/** A transfer as the API returns it. */
export interface TransferView {
    id: string;
    object: RecordObject;
    recordId: string;
    /** The record's name as it reads now; a plain label when it cannot be read. */
    recordLabel: string;
    from: TransferMember | null;
    to: TransferMember;
    proposedBy: TransferMember;
    decidedBy: TransferMember | null;
    status: TransferStatus;
    reason: string | null;
    /** What a declined transfer's receiver said, when they said anything. */
    note: string | null;
    /** Every record that moved (the unit), once the transfer completed; empty before. */
    moved: LabelledTarget[];
    /** ISO 8601. */
    createdAt: string;
    /** ISO 8601; null while proposed. */
    decidedAt: string | null;
}

/** What the bell shows for a transfer notification. */
export interface TransferSummary {
    id: string;
    object: RecordObject;
    recordId: string;
    recordLabel: string;
    from: TransferMember | null;
    to: TransferMember;
    status: TransferStatus;
    reason: string | null;
}

/**
 * What a `transfer.*` event carries. `identity` lets a receiver that keys records by email or domain
 * (not by our ids) find the record on its side: the company's domain, and the primary emails of the
 * people that moved.
 */
export interface TransferEventPayload {
    object: RecordObject;
    recordId: string;
    fromMemberId: string | null;
    toMemberId: string;
    byMemberId: string | null;
    status: TransferStatus;
    reason: string | null;
    moved: RecordTarget[];
    /**
     * A first contact's hand-over (OWN-2): a lead saved straight into the hands of the member who owns its company,
     * by whoever found it (a member, or a calendar sync). Absent on every other transfer.
     */
    firstContact?: true;
    identity: {
        companyDomain: string | null;
        personEmails: string[];
    };
}

/** How long the reason or a decline's note may be. */
export const TRANSFER_TEXT_MAX = 500;

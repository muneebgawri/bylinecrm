/**
 * Company-domain ownership (OWN-2, #201, FR-CRMS-20): the member who owns a company owns every person
 * at it and every deal with it. A company is found by its domain or one of its other domains; a person
 * by their primary address's domain, free mail left out.
 */

/** What a `409 conflict.company_owned` says in `details`. */
export interface CompanyOwnedDetails {
    companyId: string;
    companyName: string;
    ownerMemberId: string;
    ownerName: string;
    [key: string]: string;
}

/** One of a company's other domains (a group's second brand, a country site). */
export interface CompanyDomainView {
    domain: string;
    /** ISO 8601. */
    createdAt: string;
}

export const OWNERSHIP_CONFLICT_KINDS = [
    /** A person's address is at a company another member owns. */
    'domain_owned_by_other',
    /** A person, or a deal, is linked to a company another member owns. */
    'company_owner_differs',
] as const;
export type OwnershipConflictKind = (typeof OWNERSHIP_CONFLICT_KINDS)[number];

/** One record the rule disagrees with, for a manager to resolve (the backfill report). */
export interface OwnershipConflictView {
    kind: OwnershipConflictKind;
    object: 'person' | 'opportunity';
    recordId: string;
    recordLabel: string;
    recordOwnerMemberId: string | null;
    recordOwnerName: string | null;
    companyId: string;
    companyName: string;
    companyOwnerMemberId: string;
    companyOwnerName: string | null;
}

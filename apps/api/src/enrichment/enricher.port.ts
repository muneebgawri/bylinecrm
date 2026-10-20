import type { EnrichmentFactKey, EnrichmentObject, EnrichmentSource, Links } from '@bylinecrm/shared';

/** Injection token for the list of sources in use (`Enricher[]`), in the order they are asked. */
export const ENRICHERS = Symbol('ENRICHERS');

/** What a source may read about the record it is asked about — never the record itself. */
export interface EnrichmentSubject {
    /** The workspace the record is in: a source with a per-workspace link (BylineAI, BYL-2) reads it by this. */
    workspaceId?: string;
    object: EnrichmentObject;
    id: string;
    company?: {
        name: string;
        domain: string | null;
        logoUrl: string | null;
        links: Links;
        /** The primary addresses of its people. */
        peopleEmails: string[];
    };
    person?: {
        email: string | null;
        country: string | null;
    };
}

/**
 * One source's answer about one fact: found, with the value and the source's confidence (`rank`,
 * what the "better" rule compares); looked and found nothing (`no_answer` — no value, ever); or
 * could not look (`failed`, with why).
 */
export type EnrichmentFinding =
    | { field: EnrichmentFactKey; status: 'answered'; value: string; rank: number; note?: string }
    | { field: EnrichmentFactKey; status: 'no_answer'; note?: string }
    | { field: EnrichmentFactKey; status: 'failed'; note: string };

/**
 * A source of facts about people or companies (P4-2, FR-CRMS-15). The free ones are the built-in
 * four; a paid one would implement the same, named in `source`. `facts(object)` are the facts it
 * answers for an object — when `enrich` throws, each is recorded as failed. `applies` says whether
 * there is anything to ask with (a company with no domain has no website to visit). `enrich` may
 * reach the network, so it is never called inside a database transaction.
 */
export interface Enricher {
    readonly source: EnrichmentSource;
    facts(object: EnrichmentObject): readonly EnrichmentFactKey[];
    applies(subject: EnrichmentSubject): boolean;
    /** Whether the workspace has this source at all (a per-workspace link); absent means always. Asked outside a transaction. */
    available?(workspaceId: string): Promise<boolean>;
    enrich(subject: EnrichmentSubject): Promise<EnrichmentFinding[]>;
}

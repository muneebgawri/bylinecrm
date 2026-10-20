// What the CRM asks BylineAI by API key (BYL-2), and what it reads back. BylineAI authenticates `x-api-key` (or
// `Authorization: Bearer`), as its ApiKeyGuard does. Its paid layers (Apollo/PDL, Reacher, LLM) run under BylineAI's
// own budget caps: when a cap or a rate limit stops an ask, BylineAI says so with the error body below.
//
// PROPOSED: BylineAI has no per-address routes yet (its enrichment and verification run as sweeps over its own
// contacts). These two are the shape the CRM's adapters speak; BylineAI adds them to its enrichment controller.

/** `GET {baseUrl}/enrichment/:email` — what BylineAI knows about an address; `404` for nothing. */
export const BYLINE_ENRICHMENT_PATH = '/enrichment';
/** `GET {baseUrl}/verification/:email` — whether an address is deliverable. */
export const BYLINE_VERIFICATION_PATH = '/verification';

export interface BylineEnrichment {
    email: string;
    person: {
        firstName: string | null;
        lastName: string | null;
        jobTitle: string | null;
        /** ISO 3166-1 alpha-2. */
        country: string | null;
        linkedinUrl: string | null;
        avatarUrl: string | null;
    } | null;
    company: {
        name: string | null;
        domain: string | null;
        linkedinUrl: string | null;
        logoUrl: string | null;
    } | null;
    /** BylineAI's confidence, 0..1; the CRM's "better" rule compares it with its free sources'. */
    confidence: number | null;
}

export const BYLINE_VERDICTS = ['valid', 'invalid', 'risky', 'unknown'] as const;
export type BylineVerdict = (typeof BYLINE_VERDICTS)[number];

export interface BylineVerification {
    email: string;
    verdict: BylineVerdict;
    /** Free text: `mailbox_not_found`, `catch_all`, `disposable`, `role`, … */
    reason: string | null;
    /** Which of BylineAI's verifiers answered (`reacher`, `free`, …). */
    provider: string | null;
}

/**
 * An ask BylineAI would not run. `budget_exhausted` (HTTP 402): a monthly cap is reached; `rate_limited` (429): too
 * many asks; anything else is an error of BylineAI's.
 */
export interface BylineApiErrorBody {
    error: 'budget_exhausted' | 'rate_limited' | (string & {});
    message?: string;
}

// What the CRM asks BylineAI by API key (BYL-2), and what it reads back. BylineAI authenticates `x-api-key` (or
// `Authorization: Bearer`), as its ApiKeyGuard does. Its paid layers (Apollo/PDL, Reacher, LLM) run under BylineAI's
// own budget caps: when a cap or a rate limit stops an ask, BylineAI says so with the error body below.
//
// Implemented by BylineAI (pinionpartners/bylineai#3, `LookupController`). The base URL is the site origin: nginx sends
// `/(enrichment|verification)/<email>` straight to its API. The key must have the scoped `lookup` role
// (`BYLINE_API_KEYS="<key>:lookup"`); `operator`/`admin` keys work too.

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
        /** Always null: BylineAI's only photo source (the operator's Google Contacts) is not exposed. */
        avatarUrl: null;
    } | null;
    company: {
        name: string | null;
        domain: string | null;
        linkedinUrl: string | null;
        logoUrl: string | null;
    } | null;
    /**
     * BylineAI's confidence, 0..1: a known contact's authoritative score, else its provisional one; a vendor-only match
     * (an address BylineAI does not hold) is a fixed `BYLINE_VENDOR_ONLY_CONFIDENCE`.
     */
    confidence: number | null;
}

/** The confidence BylineAI gives a vendor-only match. */
export const BYLINE_VENDOR_ONLY_CONFIDENCE = 0.8;

export const BYLINE_VERDICTS = ['valid', 'invalid', 'risky', 'unknown'] as const;

/** Why, as BylineAI says it. */
export const BYLINE_VERIFICATION_REASONS = [
    'invalid_format',
    'no_mx',
    'mailbox_not_found',
    'catch_all',
    'disposable',
    'role',
    'mailbox_exists',
] as const;
export type BylineVerificationReason = (typeof BYLINE_VERIFICATION_REASONS)[number];

/** Which verifier answered: BylineAI's free Layer-0, its Reacher pool, an SMTP probe, or a paid vendor. */
export const BYLINE_VERIFICATION_PROVIDERS = [
    'free',
    'reacher',
    'smtp-probe',
    'zerobounce',
    'hunter',
    'emailable',
] as const;
export type BylineVerificationProvider = (typeof BYLINE_VERIFICATION_PROVIDERS)[number];
export type BylineVerdict = (typeof BYLINE_VERDICTS)[number];

export interface BylineVerification {
    email: string;
    verdict: BylineVerdict;
    /** One of `BYLINE_VERIFICATION_REASONS`, or null; read defensively — a newer BylineAI may add one. */
    reason: BylineVerificationReason | (string & {}) | null;
    /** One of `BYLINE_VERIFICATION_PROVIDERS`, or null. */
    provider: BylineVerificationProvider | (string & {}) | null;
}

/**
 * An ask BylineAI would not run. `budget_exhausted` (HTTP 402): a monthly cap is reached; `rate_limited` (429, with
 * `Retry-After`): too many asks; `unavailable` (503): its person-enrichment vendor pool is down or rate-limited — worth
 * asking again later. `message` is readable as is. Every error body (404 included, which has no `error`) also
 * carries Nest's `statusCode`, `timestamp` and `path`; they are ignored.
 */
export interface BylineApiErrorBody {
    error?: 'budget_exhausted' | 'rate_limited' | 'unavailable' | (string & {});
    message?: string | string[];
    statusCode?: number;
    timestamp?: string;
    path?: string;
}

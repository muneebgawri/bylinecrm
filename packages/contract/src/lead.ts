// The lead webhook: what BylineAI's WEBHOOK export connector posts (`leadEnginePayload` in
// bylineai/apps/api/src/export/connectors/webhook.connector.ts) and the answer it reads back (`outcomeFromResponse`).
// Only observed facts go over the wire — no scores, no enrichment. Optional fields are left out, not null.

export interface BylineLeadPayload {
    /** BylineAI's `Contact.id`. The receiver dedupes redelivery on it. */
    lead_id: string;
    email: string;
    first_name?: string;
    last_name?: string;
    /** E.164 when BylineAI could parse it with `country`; otherwise as BylineAI holds it. */
    phone?: string;
    company_name?: string;
    job_title?: string;
    /** ISO 3166-1 alpha-2: the contact's, else the phone's region, else the enriched location's. */
    country?: string;
    linkedin_url?: string;
    /** The release the contact was found on. */
    source_url?: string;
    /** BylineAI's source key (`prweb`, `businesswire`, …): the CRM records `byline:<source_key>`. */
    source_key?: string;
    natural_id?: string;
    pr_title?: string;
    /** ISO 8601. */
    discovered_at?: string;
}

/**
 * The receiver's answer. BylineAI reads the body, not the status code: `ingested` and `duplicate` mark the lead SENT
 * (with `personId` kept as its external id), `rejected` FAILED with `reason`, anything else FAILED as unrecognised.
 */
export type BylineLeadStatus = 'ingested' | 'duplicate' | 'rejected';

export type BylineLeadResponse =
    { status: 'ingested' | 'duplicate'; personId: string } | { status: 'rejected'; reason: string };

export const BYLINE_LEAD_STATUSES: readonly BylineLeadStatus[] = ['ingested', 'duplicate', 'rejected'];

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const STRING_FIELDS = [
    'first_name',
    'last_name',
    'phone',
    'company_name',
    'job_title',
    'country',
    'linkedin_url',
    'source_url',
    'source_key',
    'natural_id',
    'pr_title',
    'discovered_at',
] as const;

/** A delivery, read defensively: the payload, or why it cannot be one. Unknown fields are ignored. */
export function parseLeadPayload(body: unknown): { ok: true; lead: BylineLeadPayload } | { ok: false; reason: string } {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, reason: 'body is not an object' };
    const o = body as Record<string, unknown>;
    const leadId = typeof o['lead_id'] === 'string' ? o['lead_id'].trim() : '';
    if (!leadId || leadId.length > 200) return { ok: false, reason: 'lead_id is missing' };
    const email = typeof o['email'] === 'string' ? o['email'].trim().toLowerCase() : '';
    if (!EMAIL.test(email) || email.length > 320) return { ok: false, reason: 'email is missing or malformed' };
    const lead: BylineLeadPayload = { lead_id: leadId, email };
    for (const key of STRING_FIELDS) {
        const value = o[key];
        if (value === undefined || value === null) continue;
        if (typeof value !== 'string') return { ok: false, reason: `${key} is not a string` };
        const trimmed = value.trim();
        if (trimmed) lead[key] = trimmed.slice(0, 2000);
    }
    return { ok: true, lead };
}

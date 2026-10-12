/**
 * Enrichment (P4-2, FR-CRMS-15): the free sources, what each can find about a person or a company,
 * how an answer is kept, and the rule for when an answer replaces what a record already holds.
 */

/** The records enrichment knows about; a deal is not enriched. */
export const ENRICHMENT_OBJECTS = ['person', 'company'] as const;
export type EnrichmentObject = (typeof ENRICHMENT_OBJECTS)[number];

/** The free sources, in the order the settings show them. No paid API; nothing behind a login. */
export const ENRICHMENT_SOURCES = ['website', 'dns', 'gravatar', 'email_domain'] as const;
export type EnrichmentSource = (typeof ENRICHMENT_SOURCES)[number];

export const ENRICHMENT_SOURCE_LABELS: Readonly<Record<EnrichmentSource, string>> = {
    website: 'Company website',
    dns: 'DNS',
    gravatar: 'Gravatar',
    email_domain: 'Email addresses',
};

/** What each source reads, and from where — the settings page says this beside the switch. */
export const ENRICHMENT_SOURCE_NOTES: Readonly<Record<EnrichmentSource, string>> = {
    website: 'The company’s home page: its name, logo, LinkedIn and X profiles, and the domain it is served from.',
    dns: 'The company domain’s mail records: which provider handles its mail.',
    gravatar: 'A person’s public Gravatar picture, by their address.',
    email_domain:
        'A person’s country from a country-coded address; a company’s domain from the addresses its people write from, free mail excluded.',
};

/**
 * Every fact a source can answer, keyed as it is stored. `applies` names the record field it
 * fills when the answer is better than what is there (`null`: shown on the record, never written
 * to a field). `type` picks the "better" rule.
 */
export const ENRICHMENT_FACTS = {
    name: { object: 'company', type: 'text', applies: 'name', label: 'Name' },
    domain: { object: 'company', type: 'domain', applies: 'domain', label: 'Domain' },
    logo_url: { object: 'company', type: 'url', applies: 'logoUrl', label: 'Logo' },
    linkedin_url: { object: 'company', type: 'url', applies: 'links.linkedin', label: 'LinkedIn' },
    x_url: { object: 'company', type: 'url', applies: 'links.x', label: 'X profile' },
    mail_provider: { object: 'company', type: 'enum', applies: null, label: 'Mail provider' },
    avatar_url: { object: 'person', type: 'url', applies: 'avatarUrl', label: 'Picture' },
    country: { object: 'person', type: 'country', applies: 'country', label: 'Country' },
} as const satisfies Record<
    string,
    { object: EnrichmentObject; type: EnrichmentFactType; applies: string | null; label: string }
>;
export type EnrichmentFactKey = keyof typeof ENRICHMENT_FACTS;
export const ENRICHMENT_FACT_KEYS = Object.keys(ENRICHMENT_FACTS) as EnrichmentFactKey[];

export const ENRICHMENT_FACT_TYPES = ['text', 'domain', 'url', 'country', 'enum'] as const;
export type EnrichmentFactType = (typeof ENRICHMENT_FACT_TYPES)[number];

/** The mail providers the DNS source tells apart. */
export const MAIL_PROVIDERS = ['google', 'microsoft', 'other'] as const;
export type MailProvider = (typeof MAIL_PROVIDERS)[number];
export const MAIL_PROVIDER_LABELS: Readonly<Record<MailProvider, string>> = {
    google: 'Google Workspace',
    microsoft: 'Microsoft 365',
    other: 'Another provider',
};

/**
 * How an ask went for one fact: the source answered; it looked and found nothing (recorded as no
 * answer — never a zero or an empty string); or it could not look (the site down, DNS silent).
 */
export const ENRICHMENT_ANSWER_STATUSES = ['answered', 'no_answer', 'failed'] as const;
export type EnrichmentAnswerStatus = (typeof ENRICHMENT_ANSWER_STATUSES)[number];

/** A stored answer, as the record's panel shows it. */
export interface EnrichmentAnswerView {
    id: string;
    object: EnrichmentObject;
    recordId: string;
    field: EnrichmentFactKey;
    source: EnrichmentSource;
    status: EnrichmentAnswerStatus;
    /** The fact, as text; `null` unless `answered`. */
    value: string | null;
    /** The source's confidence in this fact (0 when there is none); the "better" rule compares it. */
    rank: number;
    /** Why it failed, or where a value came from on the page. */
    note: string | null;
    /** Whether the answer was written to the record's field. */
    applied: boolean;
    askedAt: string;
}

/** A record's answers, newest first, and whether a run is queued or going. */
export interface EnrichmentHistoryView {
    object: EnrichmentObject;
    recordId: string;
    lastAskedAt: string | null;
    pending: boolean;
    answers: EnrichmentAnswerView[];
}

/** What a workspace asks, and how long an answer stands before the sources are asked again. */
export interface EnrichmentSettings {
    reaskAfterDays: number;
    sources: Record<EnrichmentSource, boolean>;
}

export interface EnrichmentSettingsView extends EnrichmentSettings {
    isDefault: boolean;
    updatedAt: string | null;
}

export const ENRICHMENT_DEFAULTS: Readonly<EnrichmentSettings> = {
    reaskAfterDays: 90,
    sources: { website: true, dns: true, gravatar: true, email_domain: true },
};
export const ENRICHMENT_LIMITS = { reaskAfterDays: { min: 1, max: 365 } } as const;

/** How many answers a record's panel reads. */
export const ENRICHMENT_HISTORY_LIMIT = 100;

/**
 * FR-CRMS-15's "overwrites only when better than what is there". `current.rank` is the rank of the
 * enrichment answer that wrote the field's value, or `null` when enrichment did not — a member's
 * or an import's value, which is never replaced. An empty field takes any answer. An enrichment-
 * written value gives way to an answer of equal or higher rank (a source that changed its mind wins
 * over its own older answer), never to a lower one; the same value is never rewritten. Per type:
 * an https URL beats http at equal rank; an apex domain beats its `www.` form.
 */
export function isBetterAnswer(
    type: EnrichmentFactType,
    candidate: { value: string; rank: number },
    current: { value: string | null; rank: number | null },
): boolean {
    if (current.value === null || current.value === '') return true;
    if (current.rank === null) return false;
    if (candidate.value === current.value) return false;
    return candidate.rank + tieBreak(type, candidate.value) >= current.rank + tieBreak(type, current.value);
}

/** The within-rank preference per type, as a fraction so it never outweighs a rank. */
function tieBreak(type: EnrichmentFactType, value: string): number {
    if (type === 'url') return value.startsWith('https://') ? 0.5 : 0;
    if (type === 'domain') return value.startsWith('www.') ? 0 : 0.5;
    return 0;
}

/** A bare host: labels of letters, digits and hyphens with at least one dot and no spaces — a name nobody typed. */
const BARE_HOST = /^(www\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

/**
 * Whether a company's stored name is a placeholder the website's name may replace (#170): empty, the
 * company's own domain or host (with or without `www.`), or any bare host — an import (Twenty names
 * companies by their domain) rather than a person. A name a member typed is never a placeholder.
 */
export function isPlaceholderCompanyName(name: string | null | undefined, domain: string | null | undefined): boolean {
    const value = (name ?? '').trim().toLowerCase();
    if (value === '') return true;
    const host = (domain ?? '')
        .trim()
        .toLowerCase()
        .replace(/^www\./, '');
    if (host !== '' && value.replace(/^www\./, '') === host) return true;
    return BARE_HOST.test(value);
}

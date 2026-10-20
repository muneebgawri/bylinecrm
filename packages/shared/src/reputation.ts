/**
 * Sender-reputation guardrails (REP-1, #204, FR-CRMS-23): per-mailbox send budgets and repetition
 * detection, for mail sent in the CRM (enforced before it leaves) and mail seen through Gmail sync
 * (measured, recorded and alerted — it already left). Every refusal and every finding is a guardrail
 * event. Thresholds are the workspace's (`reputation_settings`); the defaults below apply until an
 * admin changes them. Rules and defaults: docs/design-notes/REP-1.md.
 */

export interface ReputationSettings {
    /**
     * New-recipient messages a personal mailbox may send in a rolling 24 hours (replies do not count):
     * distinct addresses on messages that start a thread.
     */
    dailyNewRecipients: number;
    /** The same, in a rolling hour — spreads a day's budget instead of spending it in one burst. */
    hourlyNewRecipients: number;
    /** A pool mailbox's sends in a rolling hour, beside its daily cap and warm-up ramp (P3-2). */
    poolHourlyCap: number;
    /**
     * Near-identical 1:1 messages (body simhash within `nearDuplicateDistance` bits) to distinct
     * recipients in 24 hours, outside a sequence, that make a bulk pattern: the next one is refused
     * ("use a sequence from the pool").
     */
    nearDuplicateThreshold: number;
    /** Hamming distance (of 64 bits) at or under which two bodies are near-identical. */
    nearDuplicateDistance: number;
    /** Distinct new recipients one normalised subject may reach in 24 hours before the next is refused. */
    subjectRepeatThreshold: number;
    /**
     * An admin's override of the workspace's primary domain (lower case), or null to derive it: the domain most
     * members sign in with. No sequence sends from a pool mailbox on the primary domain — the pool is for
     * lookalike domains — and enrolment is refused while the pool has no mailbox off it. On whenever a primary
     * domain is known.
     */
    primaryDomain: string | null;
}

export const REPUTATION_DEFAULTS: Readonly<ReputationSettings> = {
    dailyNewRecipients: 50,
    hourlyNewRecipients: 20,
    poolHourlyCap: 12,
    nearDuplicateThreshold: 10,
    nearDuplicateDistance: 3,
    subjectRepeatThreshold: 10,
    primaryDomain: null,
};

/** The bounds each number is validated against (the database checks the same). */
export const REPUTATION_LIMITS = {
    dailyNewRecipients: { min: 1, max: 2000 },
    hourlyNewRecipients: { min: 1, max: 500 },
    poolHourlyCap: { min: 1, max: 500 },
    nearDuplicateThreshold: { min: 2, max: 1000 },
    nearDuplicateDistance: { min: 0, max: 16 },
    subjectRepeatThreshold: { min: 2, max: 1000 },
} as const satisfies Record<Exclude<keyof ReputationSettings, 'primaryDomain'>, { min: number; max: number }>;

/** The window budgets and repetition are judged over. */
export const REPUTATION_WINDOW_MS = 24 * 60 * 60 * 1000;
export const REPUTATION_HOUR_MS = 60 * 60 * 1000;

/**
 * Phrases in a reply that mean "stop" — a negative signal (REP-1 §10) recorded as a `negative_reply`
 * guardrail event. Matched case-insensitively against the reply's own text (quoted text stripped).
 */
export const NEGATIVE_REPLY_PATTERNS: readonly RegExp[] = [
    /\bunsubscribe\b/i,
    /\bremove me\b/i,
    /\btake me off\b/i,
    /\bstop (?:emailing|e-mailing|contacting|sending)\b/i,
    /\bnot interested\b/i,
    /\bdo not (?:contact|email|e-mail)\b/i,
];

/** Whether a reply's text says "stop". */
export function isNegativeReply(text: string): boolean {
    return NEGATIVE_REPLY_PATTERNS.some((p) => p.test(text));
}

/** The thresholds as the API returns them (REP-1): with the primary domain in force, set or derived. */
export interface ReputationSettingsView extends ReputationSettings {
    /** `primaryDomain` when set, else the domain most members sign in with; null when neither is known. */
    effectivePrimaryDomain: string | null;
}

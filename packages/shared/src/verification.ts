/**
 * Email verification (P3-5, FR-CRMS-14, FR-CRMS-16): what a verifier answers about an address, how
 * long a workspace lets an answer stand, and the vocabulary the API and the web app share for it.
 */

/**
 * What verification found. `valid` is the only answer that says the address is deliverable to a
 * person; `invalid` that it is not (no such domain, no mail server, a disposable domain — #165);
 * `risky` that mail may arrive but not reach a person (a role address); `unknown` that nothing
 * could be decided — DNS did not answer.
 * `unknown` is not valid: it does not enrol, and it is never kept past the next check.
 */
export const EMAIL_VERIFICATION_RESULTS = ['valid', 'invalid', 'risky', 'unknown'] as const;
export type EmailVerificationResult = (typeof EMAIL_VERIFICATION_RESULTS)[number];

/** Why the result is what it is; `message` says it in words, naming the address's domain. */
export const EMAIL_VERIFICATION_REASONS = [
    'deliverable',
    'syntax',
    'no_domain',
    'no_mail_server',
    'null_mx',
    'disposable',
    'role',
    'lookup_failed',
] as const;
export type EmailVerificationReason = (typeof EMAIL_VERIFICATION_REASONS)[number];

export const EMAIL_VERIFICATION_RESULT_LABELS: Readonly<Record<EmailVerificationResult, string>> = {
    valid: 'Valid',
    invalid: 'Invalid',
    risky: 'Risky',
    unknown: 'Unknown',
};

/** What a verifier answers; `source` names the verifier (`free`, or a vendor adapter's name — P4-1). */
export interface EmailVerification {
    result: EmailVerificationResult;
    reason: EmailVerificationReason;
    message: string;
    source: string;
}

/** The free layer (syntax, MX, disposable list, role detection; no SMTP probe) names itself this. */
export const FREE_VERIFIER_SOURCE = 'free';

/** A stored answer, as the API returns it: the address it is about, when it was found, whether it still stands. */
export interface EmailVerificationView extends EmailVerification {
    address: string;
    verifiedAt: string;
    /** Older than the workspace's age, or `unknown`: the next check runs it again. */
    stale: boolean;
}

/** A person's primary address and its stored answer; `null` where there is none yet, or no address. */
export interface PersonVerificationView {
    address: string | null;
    verification: EmailVerificationView | null;
}

/** How long a result stands before it is re-run (FR-CRMS-16): the workspace's, or 90 days. */
export interface EmailVerificationSettings {
    maxAgeDays: number;
}

export interface EmailVerificationSettingsView extends EmailVerificationSettings {
    isDefault: boolean;
    updatedAt: string | null;
}

export const EMAIL_VERIFICATION_DEFAULTS: Readonly<EmailVerificationSettings> = { maxAgeDays: 90 };
export const EMAIL_VERIFICATION_LIMITS = { maxAgeDays: { min: 1, max: 365 } } as const;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whether a stored answer must be found again before it is relied on: `unknown` always; anything
 * else once it is older than the workspace's age. Dated from `verifiedAt`, not from any later read.
 */
export function isVerificationStale(
    verification: { result: EmailVerificationResult; verifiedAt: Date },
    maxAgeDays: number,
    now: Date,
): boolean {
    if (verification.result === 'unknown') return true;
    return now.getTime() - verification.verifiedAt.getTime() > maxAgeDays * DAY_MS;
}

/**
 * Local parts that name a function, not a person (RFC 2142 and the common ones around it): mail to
 * them may arrive, but outreach to them is not outreach to someone. Compared lower case.
 */
export const ROLE_LOCAL_PARTS: readonly string[] = [
    'abuse',
    'admin',
    'administrator',
    'billing',
    'careers',
    'contact',
    'enquiries',
    'editor',
    'editorial',
    'help',
    'hello',
    'hostmaster',
    'hr',
    'info',
    'inquiries',
    'jobs',
    'legal',
    'marketing',
    'media',
    'news',
    'newsletter',
    'no-reply',
    'noreply',
    'office',
    'postmaster',
    'press',
    'privacy',
    'sales',
    'security',
    'support',
    'team',
    'webmaster',
];

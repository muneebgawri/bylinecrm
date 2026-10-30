import { GmailApiError } from './gmail.port';
import {
    GMAIL_RATE_LIMIT_REASONS,
    GMAIL_RETRY_ATTEMPTS,
    GMAIL_RETRY_BASE_MS,
    GMAIL_RETRY_CAP_MS,
    GMAIL_RETRY_JITTER,
    MAIL_SYNC_RATE_LIMIT_COOLDOWN_BASE_MS,
    MAIL_SYNC_RATE_LIMIT_COOLDOWN_CAP_MS,
} from './mail-sync.constants';

/** The wait after the n-th failed attempt (1-based): base · 2^(n−1), capped, ± jitter. One function. */
export function gmailRetryDelayMs(attempt: number, random: () => number = Math.random): number {
    const base = Math.min(GMAIL_RETRY_BASE_MS * 2 ** (attempt - 1), GMAIL_RETRY_CAP_MS);
    const jitter = 1 + GMAIL_RETRY_JITTER * (2 * random() - 1);
    return Math.round(base * jitter);
}

export interface RetryOptions {
    sleep?: (ms: number) => Promise<void>;
    random?: () => number;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Runs one Gmail request, retrying a transient failure (`429`, a `5xx`, no answer) up to
 * `GMAIL_RETRY_ATTEMPTS` attempts with exponential backoff. Anything else — a `404`, an auth
 * error, a bug — is thrown at once: waiting would not change it.
 */
export async function withGmailRetry<T>(request: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
    const sleep = options.sleep ?? realSleep;
    for (let attempt = 1; ; attempt++) {
        try {
            return await request();
        } catch (error) {
            if (!(error instanceof GmailApiError) || !error.transient || attempt >= GMAIL_RETRY_ATTEMPTS) throw error;
            // Gmail named when it will take requests again (PNW-1125): asking sooner is refused anyway and spends quota.
            // Longer than this run ever waits, the run ends and the mailbox's cool-down holds until then.
            const told = error.retryAfter ? error.retryAfter.getTime() - Date.now() : 0;
            if (told > GMAIL_RETRY_CAP_MS) throw error;
            await sleep(Math.max(gmailRetryDelayMs(attempt, options.random), told));
        }
    }
}

/** A run's stored failure, as far as the cool-down reads it. */
export interface RateLimitRecord {
    code: string;
    message?: string;
    at: string;
    /** Consecutive runs that ended rate-limited, this one included. Absent for any other failure. */
    rateLimitedRuns?: number;
    /** When Gmail said it would take requests again (ISO 8601), when it said (PNW-1125). */
    retryAfter?: string;
}

const isRateLimitCode = (code: string) => GMAIL_RATE_LIMIT_REASONS.has(code.replace(/^gmail\./, ''));

/**
 * How many consecutive runs have ended rate-limited, once `failure` is recorded over `previous` — undefined when this
 * failure is not a rate limit, so any other outcome starts the count over.
 */
export function rateLimitedRuns(failure: RateLimitRecord, previous: RateLimitRecord | null): number | undefined {
    if (!isRateLimitCode(failure.code)) return undefined;
    return previous && isRateLimitCode(previous.code) ? (previous.rateLimitedRuns ?? 1) + 1 : 1;
}

/** When a mailbox whose last run ended rate-limited may be synced again (epoch ms); 0 when it is not cooling down. */
export function rateLimitCooldownUntil(lastError: RateLimitRecord | null): number {
    if (!lastError || !isRateLimitCode(lastError.code)) return 0;
    const n = lastError.rateLimitedRuns ?? 1;
    const wait = Math.min(MAIL_SYNC_RATE_LIMIT_COOLDOWN_BASE_MS * 2 ** (n - 1), MAIL_SYNC_RATE_LIMIT_COOLDOWN_CAP_MS);
    // Never sooner than Gmail said it would take requests again (PNW-1125); the backoff when it said nothing, or sooner.
    const told = lastError.retryAfter ? Date.parse(lastError.retryAfter) : Number.NaN;
    return Math.max(Date.parse(lastError.at) + wait, Number.isNaN(told) ? 0 : told);
}

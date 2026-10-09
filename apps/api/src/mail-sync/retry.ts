import { GmailApiError } from './gmail.port';
import {
    GMAIL_RETRY_ATTEMPTS,
    GMAIL_RETRY_BASE_MS,
    GMAIL_RETRY_CAP_MS,
    GMAIL_RETRY_JITTER,
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
            await sleep(gmailRetryDelayMs(attempt, options.random));
        }
    }
}

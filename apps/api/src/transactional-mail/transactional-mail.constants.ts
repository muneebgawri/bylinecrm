/**
 * Every number transactional mail runs on (#93), in one place. A value here is a decision; the code
 * that uses it says what it is for. The relay's shape follows P1-6's outbox (`outbox.constants.ts`).
 */

/** How often the relay scans for mail no local commit announced (other processes, retries come due). */
export const MAIL_OUTBOX_POLL_MS = 2_000;
/** Mails one scan claims; a full batch means scan again at once. */
export const MAIL_OUTBOX_BATCH = 20;
/** Mails sent at once: mail is small and the provider rate-limits per key. */
export const MAIL_OUTBOX_CONCURRENCY = 2;
/** How long a claim holds a mail; longer than a provider request may take (`RESEND_TIMEOUT_MS`). */
export const MAIL_OUTBOX_LEASE_MS = 60_000;
/** Attempts for a transient failure (network, 429, 5xx) before the mail is given up on. */
export const MAIL_OUTBOX_MAX_ATTEMPTS = 8;
/** The first retry's wait; each later one doubles, up to the cap. */
export const MAIL_OUTBOX_RETRY_BASE_MS = 30_000;
export const MAIL_OUTBOX_RETRY_CAP_MS = 30 * 60_000;

/** The wait before attempt `attempts + 1`. */
export function mailRetryDelayMs(attempts: number): number {
    return Math.min(MAIL_OUTBOX_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1), MAIL_OUTBOX_RETRY_CAP_MS);
}

/** Sent mail's row (its payload already wiped) is kept this long, failed mail longer, then deleted. */
export const MAIL_OUTBOX_RETENTION_DAYS = { sent: 7, failed: 30 } as const;
export const MAIL_OUTBOX_RETENTION_EVERY_MS = 60 * 60_000;

/** Resend's send endpoint, and how long one request may take before it counts as failed. */
export const RESEND_SEND_URL = 'https://api.resend.com/emails';
export const RESEND_TIMEOUT_MS = 10_000;

/** Messages the memory transport keeps (newest last) for the test suite and a developer. */
export const MEMORY_OUTBOX_CAPACITY = 200;

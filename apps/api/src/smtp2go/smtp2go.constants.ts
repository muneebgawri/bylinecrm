/** SMTP2Go's API (TRANS-1). */
export const SMTP2GO_API_URL = 'https://api.smtp2go.com/v3';
export const SMTP2GO_HTTP_TIMEOUT_MS = 20_000;

/** Where SMTP2Go's webhook posts, per pool mailbox: `/api/hooks/smtp2go/<mailboxId>`. */
export const SMTP2GO_HOOK_PATH = '/api/hooks/smtp2go';

/** Refused deliveries per client IP per window before the hook answers `429`. */
export const SMTP2GO_HOOK_FAILURE_LIMIT = 30;
export const SMTP2GO_HOOK_FAILURE_WINDOW_S = 600;
export const smtp2goHookRateKey = (ip: string) => `smtp2go-hook:${ip}`;

/** "Send test" (TRANS-1): at most this many per mailbox per window, so the button cannot become a sender. */
export const SMTP2GO_TEST_LIMIT = 5;
export const SMTP2GO_TEST_WINDOW_S = 3600;
export const smtp2goTestRateKey = (mailboxId: string) => `smtp2go-test:${mailboxId}`;

/** SMTP2Go's include, which a sending domain's SPF may name instead of Google's. */
export const SMTP2GO_SPF_INCLUDE = 'spf.smtp2go.com';

/** An SMTP2Go API key as it issues them: `api-` and 32 hex characters (accepted a little wider). */
export const SMTP2GO_API_KEY_PATTERN = /^api-[A-Za-z0-9]{16,64}$/;

/** Prefix of the provider ids a send through SMTP2Go is stored under, so they never meet Gmail's. */
export const SMTP2GO_PROVIDER_PREFIX = 'smtp2go:';

/**
 * A send SMTP2Go rejected after taking it (TRANS-1), by whose doing: `smtp2go.rejected` — ours (an unverified
 * sender, a sandboxed or broken key), which counts towards the mailbox's pause; `smtp2go.rejected_suppressed` — the
 * recipient is on SMTP2Go's suppressions, which suppresses the address here too and pauses nothing.
 */
export const SMTP2GO_REJECTED = 'smtp2go.rejected';
export const SMTP2GO_REJECTED_SUPPRESSED = 'smtp2go.rejected_suppressed';

/** CALL-1: Quo's API (formerly OpenPhone) — one base, one version, an API key in `Authorization`. */
export const QUO_API_BASE = 'https://api.quo.com';
export const QUO_API_VERSION = '2026-03-30';
export const QUO_HTTP_TIMEOUT_MS = 15_000;
/**
 * Where Quo posts call events, under the tenant prefix; the CRM registers it at Quo itself. Under `inbound/`, as
 * BylineAI's receiver is, so the body parser keeps the raw bytes the signature is over.
 */
export const QUO_HOOK_PATH = 'inbound/quo';
/** The events the CRM subscribes to: the call's life, then what Quo adds to it afterwards. */
export const QUO_WEBHOOK_EVENTS = [
    'call.completed',
    'call.missed',
    'call.voicemail.completed',
    'call.recording.completed',
    'call.summary.completed',
    'call.transcript.completed',
] as const;
export const QUO_WEBHOOK_LABEL = 'BylineCRM calls';
/** A delivery signed more than this long ago (or ahead) is refused: Svix's own tolerance. */
export const QUO_SIGNATURE_TOLERANCE_S = 300;
/** Refused deliveries (unknown workspace, bad signature) per client address per window, before 429. */
export const QUO_HOOK_FAILURE_LIMIT = 30;
export const QUO_HOOK_FAILURE_WINDOW_S = 600;
export const quoHookRateKey = (clientIp: string) => `quo-hook:refused:${clientIp}`;
/** A call event not about a call (a message, a contact) is acknowledged and ignored. */
export const QUO_IGNORED = 'ignored';

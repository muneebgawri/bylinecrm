/**
 * Every number and fixed string invoices on a deal (INV-1) run on. Why each is what it is, and the contract with
 * NewswireOS: docs/design-notes/INV-1.md.
 */

/** The queue an invoice's verification runs on, and its job. One job per invoice (`jobId` is the invoice). */
export const INVOICE_VERIFY_QUEUE = 'invoice-verification';
export const INVOICE_VERIFY_JOB = 'verify';
/** NewswireOS not answering is retried: three tries with exponential backoff from 5 s, then `needs_review`. */
export const INVOICE_VERIFY_ATTEMPTS = 3;
export const INVOICE_VERIFY_BACKOFF_MS = 5_000;
/**
 * INV-2: the sweep that re-queues an invoice still `verifying` whose job was lost (Redis down when it was entered,
 * a worker that died holding it): how often it runs, how long an invoice waits before it counts as lost (longer
 * than every attempt's backoff together), and how many one run takes.
 */
export const INVOICE_SWEEP_JOB = 'sweep';
export const INVOICE_SWEEP_EVERY_MS = 10 * 60_000;
export const INVOICE_STUCK_AFTER_MS = 10 * 60_000;
export const INVOICE_SWEEP_BATCH = 500;

/** NewswireOS's lookup (token scope `payment_verification:lookup`): where, and how long a call may take. */
export const NEWSWIREOS_LOOKUP_PATH = '/api/v1/crm/payment-verification/lookup';
export const NEWSWIREOS_TIMEOUT_MS = 10_000;
/** At most this many client addresses go with a lookup (newswireos#647): the contact's first, then the company's. */
export const NEWSWIREOS_CLIENT_EMAILS_MAX = 20;

/** Where NewswireOS posts refunds and chargebacks: `APP_URL` + this + `/<token>`. */
export const NEWSWIREOS_HOOK_PATH = '/api/hooks/newswireos';
/**
 * NewswireOS's outbound webhook format: `sha256=<lowercase hex HMAC-SHA256 of the raw body>` with the secret
 * NewswireOS minted (`whsec_…`, pasted into Byline). It also sends `x-webhook-id` and `x-webhook-event`.
 */
export const NEWSWIREOS_SIGNATURE_HEADER = 'x-webhook-signature';
/**
 * INV-2: replay protection. NewswireOS sends when it signed (`x-webhook-timestamp`, Unix seconds) and signs
 * `${timestamp}.${body}` (`x-webhook-signature-v2: sha256=…`); a delivery signed further than the tolerance from now
 * is refused, so one captured on the wire cannot be posted again later. The plain body signature stays for
 * NewswireOS's other subscribers; the CRM no longer accepts it alone.
 */
export const NEWSWIREOS_TIMESTAMP_HEADER = 'x-webhook-timestamp';
export const NEWSWIREOS_TIMED_SIGNATURE_HEADER = 'x-webhook-signature-v2';
export const NEWSWIREOS_SIGNATURE_TOLERANCE_S = 300;
/** The delivery's id, the same on every retry: what a timeline event (PNW-766) is de-duplicated on. */
export const NEWSWIREOS_WEBHOOK_ID_HEADER = 'x-webhook-id';
export const NEWSWIREOS_SECRET_MIN = 1;
export const NEWSWIREOS_SECRET_MAX = 500;
/** A delivery's `id` is remembered this long, so a redelivery is acknowledged and not applied again. */
export const NEWSWIREOS_DELIVERY_SEEN_S = 7 * 24 * 60 * 60;
export const newswireosDeliveryKey = (workspaceId: string, id: string) => `newswireos-hook:seen:${workspaceId}:${id}`;
export const NEWSWIREOS_TOKEN_MAX = 500;
export const NEWSWIREOS_BASE_URL_MAX = 200;
/** The public hook's brake on refused deliveries, per client IP (as Slotline's). */
export const NEWSWIREOS_HOOK_FAILURE_LIMIT = 30;
export const NEWSWIREOS_HOOK_FAILURE_WINDOW_S = 600;
export const newswireosHookRateKey = (ip: string) => `newswireos-hook:${ip}`;

/**
 * The reason codes the CRM sets itself; NewswireOS's own (`AMOUNT_MISMATCH`, `PROVIDER_ERROR`, …) are stored as
 * it sends them.
 */
export const INVOICE_REASONS = {
    /** The workspace has no NewswireOS link: a person with `invoice:verify` decides. */
    noLink: 'NO_LINK',
    /** A bank transfer has no feed: a person confirms it. */
    bankWire: 'AWAITING_BANK_CONFIRMATION',
    tokenRefused: 'TOKEN_REFUSED',
    /** NewswireOS's 403: the token is good but lacks `payment_verification:lookup`. */
    tokenLacksScope: 'TOKEN_LACKS_SCOPE',
    /** NewswireOS says another release already holds this payment: a person decides whether it is this deal's. */
    alreadyUsed: 'ALREADY_USED',
    providerError: 'PROVIDER_ERROR',
    badRequest: 'BAD_REQUEST',
    /**
     * NewswireOS could not resolve a NewswireOS invoice number (not found, or the gateway is not supported yet): a
     * person checks it, since the payment may well be fine.
     */
    invoiceNumberUnresolved: 'INVOICE_NUMBER_UNRESOLVED',
    noDecision: 'NO_DECISION',
    manual: 'MANUAL',
    refunded: 'REFUNDED',
    disputed: 'DISPUTED',
} as const;

/**
 * PNW-765: completed ownership transfers pushed to NewswireOS (token scope `crm:ownership_write`), so its account
 * managers follow the CRM's owners. One job per delivery (`jobId` is the delivery); NewswireOS not answering, or
 * answering 5xx/429, is retried with exponential backoff from 10 s (eight tries span about 20 minutes), then the
 * delivery is `failed`. Any other 4xx is final at once; a 404 is `not_ready` (the route is not deployed yet).
 */
export const OWNERSHIP_PUSH_QUEUE = 'newswireos-ownership-push';
export const OWNERSHIP_PUSH_JOB = 'push';
export const OWNERSHIP_PUSH_ATTEMPTS = 8;
export const OWNERSHIP_PUSH_BACKOFF_MS = 10_000;
export const NEWSWIREOS_OWNERSHIP_PATH = '/api/v1/crm/ownership-changed';
export const NEWSWIREOS_OWNERSHIP_SCOPE = 'crm:ownership_write';
/** Deliveries the settings page lists, newest first. */
export const OWNERSHIP_DELIVERIES_SHOWN = 20;
/**
 * The sweep (a lost Redis job, a crash between the row and its job): every 10 minutes, a delivery still `pending` 15
 * minutes after it was written, with no job, is queued again (at most 500 a pass).
 */
export const OWNERSHIP_PUSH_SWEEP_EVERY_MS = 10 * 60_000;
export const OWNERSHIP_PUSH_STUCK_MS = 15 * 60_000;
export const OWNERSHIP_PUSH_SWEEP_MAX = 500;
/** At most this many addresses go with a push (NewswireOS's limit). `event_id` is a UUID, well under its 200. */
export const NEWSWIREOS_OWNERSHIP_EMAILS_MAX = 200;
/** NewswireOS's codes that settle a push for good, whatever status they come with: never retried. */
export const OWNERSHIP_PUSH_FINAL_CODES: ReadonlySet<string> = new Set(['STALE', 'NO_AM_FOR_EMAIL']);
/** A delivery's `reasonCode` when the CRM set it rather than NewswireOS. */
export const OWNERSHIP_PUSH_REASONS = {
    /** NewswireOS answered 404: the route is not deployed yet. */
    notReady: 'NEWSWIREOS_NOT_READY',
    /** NewswireOS's 401: a bad token. */
    tokenRefused: 'TOKEN_REFUSED',
    /** NewswireOS's 403: the token lacks `crm:ownership_write`. */
    tokenLacksScope: 'TOKEN_LACKS_SCOPE',
    /** NewswireOS's 400: a malformed body. */
    badRequest: 'BAD_REQUEST',
    rejected: 'REJECTED',
    unavailable: 'NEWSWIREOS_UNAVAILABLE',
    /** The push was turned off, or NewswireOS unlinked, before the delivery went. */
    pushOff: 'PUSH_OFF',
} as const;

/**
 * PNW-766 (doc 11 §8s): won deals pushed to NewswireOS (token scope `crm:client_write`), which makes their contacts
 * clients. The same delivery rules as the ownership push: one job per delivery, eight tries with exponential backoff
 * from 10 s for no answer, a 5xx or a 429; any other 4xx final at once; a 404 `not_ready`. The CRM's own reason codes
 * are `OWNERSHIP_PUSH_REASONS`'.
 */
export const DEAL_WON_PUSH_QUEUE = 'newswireos-deal-won-push';
export const DEAL_WON_PUSH_JOB = 'push';
export const NEWSWIREOS_DEAL_WON_PATH = '/api/v1/crm/deal-won';
export const NEWSWIREOS_DEAL_WON_SCOPE = 'crm:client_write';
/** PNW-766: how many of the latest won deals "Send test" looks through for one that qualifies. */
export const DEAL_WON_PREVIEW_SCAN = 50;

/**
 * PNW-766: the NewswireOS events the hook puts on the timeline (FR-CRM-6c), in NewswireOS's own names. Each becomes
 * an `external.newswireos_<event>` entry, source `newswireos`, keyed on the delivery's id.
 */
export const NEWSWIREOS_TIMELINE_EVENTS = [
    'client.created',
    'order.paid',
    'invoice.paid',
    'distribution.completed',
    'am.assigned',
] as const;
export type NewswireosTimelineEventType = (typeof NEWSWIREOS_TIMELINE_EVENTS)[number];
export const NEWSWIREOS_TIMELINE_SOURCE = 'newswireos';
/** The source of an exclusion NewswireOS's clients make (the client sync's and the hook's), and its note. */
export const NEWSWIREOS_CLIENT_SOURCE = 'newswireos';
export const NEWSWIREOS_CLIENT_NOTE = 'NewswireOS client';

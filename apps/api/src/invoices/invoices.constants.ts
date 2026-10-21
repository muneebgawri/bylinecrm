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

/** NewswireOS's lookup (token scope `payment_verification:lookup`): where, and how long a call may take. */
export const NEWSWIREOS_LOOKUP_PATH = '/api/v1/crm/payment-verification/lookup';
export const NEWSWIREOS_TIMEOUT_MS = 10_000;

/** Where NewswireOS posts refunds and chargebacks: `APP_URL` + this + `/<token>`. */
export const NEWSWIREOS_HOOK_PATH = '/api/hooks/newswireos';
/**
 * NewswireOS's outbound webhook format: `sha256=<lowercase hex HMAC-SHA256 of the raw body>` with the secret
 * NewswireOS minted (`whsec_…`, pasted into Byline). It also sends `x-webhook-id` and `x-webhook-event`.
 */
export const NEWSWIREOS_SIGNATURE_HEADER = 'x-webhook-signature';
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

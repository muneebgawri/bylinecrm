/**
 * Outbound webhooks (P1-5; corpus doc 48 §8): the vocabulary a receiver, the API and the web app
 * share. The signing scheme is defined here once — `signaturePayload` is what both the sender's
 * HMAC and a receiver's verification are computed over — so a receiver written against this file
 * cannot disagree with the API about what was signed.
 */

/** The header carrying `t=<unix seconds>,v1=<hex>[,v1=<hex>]` (two `v1` entries during a secret rotation). */
export const WEBHOOK_SIGNATURE_HEADER = 'x-byline-signature';
/** The event's type (`person.created`, `deal.won`, or `ping` for a test send). */
export const WEBHOOK_EVENT_HEADER = 'x-byline-event';
/** The delivery's id: the same id on every attempt of one delivery, so a receiver can dedupe. */
export const WEBHOOK_DELIVERY_HEADER = 'x-byline-delivery';
/** The unix-seconds timestamp the signature was computed with, repeated outside the signature header. */
export const WEBHOOK_TIMESTAMP_HEADER = 'x-byline-timestamp';

/** The signature scheme version, as it appears in the header. */
export const WEBHOOK_SIGNATURE_VERSION = 'v1';

/**
 * A receiver should refuse a delivery whose timestamp is further than this from its own clock:
 * the signature proves who sent it, the window proves when, and together they stop a captured
 * request from being replayed later. Replay protection is the receiver's to apply.
 */
export const WEBHOOK_REPLAY_WINDOW_S = 5 * 60;

/** Subscribing to every catalogue event, present and future. */
export const WEBHOOK_EVENT_WILDCARD = '*';
/** The event a test send carries; it is not a catalogue event and never reaches a subscription. */
export const WEBHOOK_PING_EVENT = 'ping';

/** A secret as shown once: `whsec_<base64url>`. The prefix is what a list shows afterwards. */
export const WEBHOOK_SECRET_PREFIX = 'whsec';

export const WEBHOOK_DELIVERY_STATUSES = ['pending', 'delivering', 'succeeded', 'failed', 'dead'] as const;
export type WebhookDeliveryStatus = (typeof WEBHOOK_DELIVERY_STATUSES)[number];

/** Limits on what an endpoint may be told. */
export const WEBHOOK_URL_MAX = 2048;
export const WEBHOOK_DESCRIPTION_MAX = 200;
export const WEBHOOK_DELIVERIES_LIMIT_DEFAULT = 50;
export const WEBHOOK_DELIVERIES_LIMIT_MAX = 200;

/**
 * The string the HMAC is computed over: the timestamp, a dot, the exact request body. A receiver
 * recomputes it from the header's `t` and the raw bytes it received — never from a re-serialised
 * body, whose key order or spacing may differ.
 */
export function signaturePayload(timestampSeconds: number, body: string): string {
    return `${timestampSeconds}.${body}`;
}

/** A parsed signature header. `signatures` holds every `v1` value; any one matching is enough. */
export interface ParsedWebhookSignature {
    timestamp: number;
    signatures: string[];
}

/** Parses `t=…,v1=…[,v1=…]`; `null` for anything else. Shared so a receiver can read it the same way. */
export function parseWebhookSignature(header: string): ParsedWebhookSignature | null {
    let timestamp: number | null = null;
    const signatures: string[] = [];
    for (const part of header.split(',')) {
        const eq = part.indexOf('=');
        if (eq < 0) return null;
        const key = part.slice(0, eq).trim();
        const value = part.slice(eq + 1).trim();
        if (key === 't') {
            if (!/^\d+$/.test(value)) return null;
            timestamp = Number(value);
        } else if (key === WEBHOOK_SIGNATURE_VERSION) {
            if (!/^[0-9a-f]{64}$/.test(value)) return null;
            signatures.push(value);
        } else {
            return null;
        }
    }
    if (timestamp === null || signatures.length === 0) return null;
    return { timestamp, signatures };
}

/** What a delivery's body is: an envelope around the event as the catalogue defines it. */
export interface WebhookEnvelope<TData = unknown> {
    /** The delivery's id — one per (endpoint, event); the same across retries. */
    id: string;
    /** The event type, or `ping`. */
    event: string;
    /** ISO 8601, UTC: when the event happened (the domain event's `occurredAt`). */
    occurredAt: string;
    workspaceId: string;
    /** The domain event itself, unreshaped. A ping carries `{ ping: true }`. */
    data: TData;
}

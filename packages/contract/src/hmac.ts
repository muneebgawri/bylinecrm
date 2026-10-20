// The two HMAC schemes on BylineAI's wires (mirrors bylineai/packages/contract/src/hmac.ts and the WEBHOOK export
// connector, bylineai/apps/api/src/export/connectors/webhook.connector.ts).
//
// - Ingest (producers → BylineAI): "sha256=" + hex(HMAC-SHA256(key, `${timestamp}.${rawBody}`)), timestamp in unix
//   seconds, 300 s tolerance. `signPayload` / `verifySignature`, as BylineAI's contract has them.
// - Lead webhook (BylineAI → CRM, header `x-byline-signature`): "sha256=" + hex(HMAC-SHA256(secret, rawBody)) over the
//   exact bytes sent, no timestamp. `signWebhook` / `verifyWebhook`. Replays are harmless: the receiver is idempotent
//   on `lead_id`.

import { createHmac, timingSafeEqual } from 'node:crypto';

/** The header BylineAI's WEBHOOK connector signs a lead delivery in. */
export const BYLINE_SIGNATURE_HEADER = 'x-byline-signature';

export function signPayload(key: string, timestamp: string | number, rawBody: string): string {
    const mac = createHmac('sha256', key).update(`${timestamp}.${rawBody}`).digest('hex');
    return `sha256=${mac}`;
}

export interface VerifyInput {
    key: string;
    timestamp: string | undefined;
    rawBody: string;
    signature: string | undefined;
    toleranceSec?: number;
    nowSec?: number;
}

export type VerifyResult = { ok: true } | { ok: false; reason: 'missing' | 'bad_timestamp' | 'skew' | 'bad_signature' };

export function verifySignature(input: VerifyInput): VerifyResult {
    const { key, timestamp, rawBody, signature, toleranceSec = 300 } = input;
    if (!key || !signature || !timestamp) return { ok: false, reason: 'missing' };
    const ts = Number(timestamp);
    if (!Number.isFinite(ts)) return { ok: false, reason: 'bad_timestamp' };
    const now = input.nowSec ?? Math.floor(Date.now() / 1000);
    if (Math.abs(now - ts) > toleranceSec) return { ok: false, reason: 'skew' };
    return equal(signPayload(key, timestamp, rawBody), signature)
        ? { ok: true }
        : { ok: false, reason: 'bad_signature' };
}

/** The `x-byline-signature` of a lead delivery: over the exact bytes sent. */
export function signWebhook(secret: string, rawBody: string | Buffer): string {
    return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

/** Whether `signature` is `signWebhook(secret, rawBody)`, compared in constant time. */
export function verifyWebhook(secret: string, rawBody: string | Buffer, signature: string | undefined): boolean {
    if (!secret || !signature) return false;
    return equal(signWebhook(secret, rawBody), signature.trim());
}

function equal(expected: string, provided: string): boolean {
    const a = Buffer.from(expected);
    const b = Buffer.from(provided);
    return a.length === b.length && timingSafeEqual(a, b);
}

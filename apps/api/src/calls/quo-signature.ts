import { createHmac, timingSafeEqual } from 'node:crypto';
import { QUO_SIGNATURE_TOLERANCE_S } from './calls.constants';

/** The headers a Quo delivery carries (Standard Webhooks, as Svix sends them). */
export const QUO_ID_HEADER = 'webhook-id';
export const QUO_TIMESTAMP_HEADER = 'webhook-timestamp';
export const QUO_SIGNATURE_HEADER = 'webhook-signature';

/**
 * Whether a delivery was signed with the webhook's `whsec_…` key: HMAC-SHA256 over `{id}.{timestamp}.{raw body}`
 * with the key's base64-decoded bytes, base64-encoded, matching any `v1,<signature>` entry of the header — and
 * the timestamp within tolerance, so a captured delivery cannot be replayed later. Constant-time compare.
 */
export function verifyQuoSignature(input: {
    secret: string;
    id: string | undefined;
    timestamp: string | undefined;
    signature: string | undefined;
    rawBody: Buffer | undefined;
    now?: Date;
}): boolean {
    const { secret, id, timestamp, signature, rawBody } = input;
    if (!id || !timestamp || !signature || !rawBody) return false;
    if (!/^\d+$/.test(timestamp)) return false;
    const nowS = Math.floor((input.now ?? new Date()).getTime() / 1000);
    if (Math.abs(nowS - Number(timestamp)) > QUO_SIGNATURE_TOLERANCE_S) return false;
    const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
    if (key.length === 0) return false;
    const expected = createHmac('sha256', key).update(`${id}.${timestamp}.`).update(rawBody).digest();
    for (const entry of signature.split(/\s+/)) {
        const [version, value] = entry.split(',');
        if (version !== 'v1' || !value) continue;
        const given = Buffer.from(value, 'base64');
        if (given.length === expected.length && timingSafeEqual(given, expected)) return true;
    }
    return false;
}

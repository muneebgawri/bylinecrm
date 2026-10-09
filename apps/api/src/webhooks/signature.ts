import { createHmac, randomBytes } from 'node:crypto';
import { WEBHOOK_SECRET_PREFIX, WEBHOOK_SIGNATURE_VERSION, signaturePayload } from '@bylinecrm/shared';
import { WEBHOOK_SECRET_BYTES, WEBHOOK_SECRET_PREFIX_CHARS } from './webhooks.constants';

/** HMAC-SHA256 of `signaturePayload(t, body)` under one secret, hex. */
export function hmacHex(secret: string, timestampSeconds: number, body: string): string {
    return createHmac('sha256', secret).update(signaturePayload(timestampSeconds, body)).digest('hex');
}

/**
 * The signature header for one request: the timestamp and a `v1` entry per secret. Two secrets
 * during a rotation's grace window, so a receiver still holding the old one verifies; one
 * otherwise. The same function signs a real delivery and a test send.
 */
export function signatureHeader(secrets: readonly string[], timestampSeconds: number, body: string): string {
    if (secrets.length === 0) throw new Error('a delivery needs at least one secret to sign with');
    const parts = [`t=${timestampSeconds}`];
    for (const secret of secrets) parts.push(`${WEBHOOK_SIGNATURE_VERSION}=${hmacHex(secret, timestampSeconds, body)}`);
    return parts.join(',');
}

/** A fresh secret as the admin sees it once: `whsec_<base64url of 32 random bytes>`. */
export function generateWebhookSecret(): string {
    return `${WEBHOOK_SECRET_PREFIX}_${randomBytes(WEBHOOK_SECRET_BYTES).toString('base64url')}`;
}

/** What a list shows of a secret afterwards: the prefix and the first characters. */
export function secretPrefixOf(secret: string): string {
    const body = secret.slice(WEBHOOK_SECRET_PREFIX.length + 1);
    return `${WEBHOOK_SECRET_PREFIX}_${body.slice(0, WEBHOOK_SECRET_PREFIX_CHARS)}…`;
}

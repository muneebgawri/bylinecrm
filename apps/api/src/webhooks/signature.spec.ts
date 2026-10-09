import { createHmac } from 'node:crypto';
import { parseWebhookSignature, signaturePayload } from '@bylinecrm/shared';
import { describe, expect, it } from 'vitest';
import { generateWebhookSecret, hmacHex, secretPrefixOf, signatureHeader } from './signature';

describe('webhook signatures', () => {
    const secret = 'whsec_test-secret';
    const timestamp = 1_760_000_000;
    const body = '{"id":"d1","event":"ping","data":{"ping":true}}';

    it('is HMAC-SHA256 over `t.body` under the secret — the golden value a receiver must reproduce', () => {
        const expected = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
        expect(hmacHex(secret, timestamp, body)).toBe(expected);
        expect(hmacHex(secret, timestamp, body)).toMatch(/^[0-9a-f]{64}$/);
        expect(hmacHex('another', timestamp, body)).not.toBe(expected);
        expect(signaturePayload(timestamp, body)).toBe(`${timestamp}.${body}`);
    });

    it('writes one v1 per secret, and the shared parser reads it back', () => {
        const header = signatureHeader([secret, 'whsec_previous'], timestamp, body);
        const parsed = parseWebhookSignature(header);
        expect(parsed).toEqual({
            timestamp,
            signatures: [hmacHex(secret, timestamp, body), hmacHex('whsec_previous', timestamp, body)],
        });
        expect(signatureHeader([secret], timestamp, body).split(',')).toHaveLength(2);
        expect(() => signatureHeader([], timestamp, body)).toThrow();
    });

    it('the parser refuses anything that is not t and v1 entries', () => {
        expect(parseWebhookSignature('t=abc,v1=00')).toBeNull();
        expect(parseWebhookSignature('v1=' + 'a'.repeat(64))).toBeNull();
        expect(parseWebhookSignature('t=1,v2=' + 'a'.repeat(64))).toBeNull();
        expect(parseWebhookSignature('t=1,v1=' + 'a'.repeat(64))).toEqual({
            timestamp: 1,
            signatures: ['a'.repeat(64)],
        });
    });

    it('a generated secret is prefixed, random, and shown only by its head afterwards', () => {
        const a = generateWebhookSecret();
        const b = generateWebhookSecret();
        expect(a).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
        expect(a).not.toBe(b);
        expect(secretPrefixOf(a)).toBe(`whsec_${a.slice(6, 14)}…`);
    });
});

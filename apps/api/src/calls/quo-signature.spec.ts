import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyQuoSignature } from './quo-signature';

const KEY = Buffer.from('a-signing-key-of-some-length-32b').toString('base64');
const secret = `whsec_${KEY}`;
const now = new Date('2026-11-09T10:00:00Z');
const ts = String(Math.floor(now.getTime() / 1000));
const body = Buffer.from('{"type":"call.completed","data":{"resource":{"id":"AC1"}}}');
const sign = (id: string, t: string, b: Buffer, k = KEY) =>
    createHmac('sha256', Buffer.from(k, 'base64')).update(`${id}.${t}.`).update(b).digest('base64');

describe('CALL-1 Quo webhook signature (Standard Webhooks)', () => {
    it('accepts a delivery signed with the key over id.timestamp.body', () => {
        expect(
            verifyQuoSignature({
                secret,
                id: 'msg_1',
                timestamp: ts,
                signature: `v1,${sign('msg_1', ts, body)}`,
                rawBody: body,
                now,
            }),
        ).toBe(true);
    });

    it('accepts any v1 entry among several, and ignores other versions', () => {
        const sig = `v2,abc v1,${sign('msg_1', ts, body)}`;
        expect(verifyQuoSignature({ secret, id: 'msg_1', timestamp: ts, signature: sig, rawBody: body, now })).toBe(
            true,
        );
    });

    it('refuses another key, another body, another id, and a stale timestamp', () => {
        const good = sign('msg_1', ts, body);
        expect(
            verifyQuoSignature({
                secret: `whsec_${Buffer.from('other-key').toString('base64')}`,
                id: 'msg_1',
                timestamp: ts,
                signature: `v1,${good}`,
                rawBody: body,
                now,
            }),
        ).toBe(false);
        expect(
            verifyQuoSignature({
                secret,
                id: 'msg_1',
                timestamp: ts,
                signature: `v1,${good}`,
                rawBody: Buffer.from('{}'),
                now,
            }),
        ).toBe(false);
        expect(
            verifyQuoSignature({ secret, id: 'msg_2', timestamp: ts, signature: `v1,${good}`, rawBody: body, now }),
        ).toBe(false);
        const old = String(Number(ts) - 600);
        expect(
            verifyQuoSignature({
                secret,
                id: 'msg_1',
                timestamp: old,
                signature: `v1,${sign('msg_1', old, body)}`,
                rawBody: body,
                now,
            }),
        ).toBe(false);
        expect(
            verifyQuoSignature({ secret, id: undefined, timestamp: ts, signature: `v1,${good}`, rawBody: body, now }),
        ).toBe(false);
    });
});

import { parseLeadPayload, signWebhook, verifyWebhook, signPayload, verifySignature } from '@byline/contract';
import { describe, expect, it } from 'vitest';
import { keepsRawBody } from '../infra/errors/body-parsing';
import { bylineSource } from './byline.constants';
import { dealTo } from './round-robin';

describe('BYL-1 BylineAI lead receiver: the pure parts', () => {
    describe('the webhook signature (@byline/contract, as BylineAI’s WEBHOOK connector signs)', () => {
        const raw = JSON.stringify({ lead_id: 'c1', email: 'dana@acme.com' });

        it('is sha256= and the hex HMAC of the exact bytes', () => {
            expect(signWebhook('s3cret-s3cret-s3cret', raw)).toMatch(/^sha256=[0-9a-f]{64}$/);
            expect(
                verifyWebhook('s3cret-s3cret-s3cret', Buffer.from(raw), signWebhook('s3cret-s3cret-s3cret', raw)),
            ).toBe(true);
        });

        it('refuses another secret, other bytes, a bare hex, or nothing', () => {
            const good = signWebhook('s3cret-s3cret-s3cret', raw);
            expect(verifyWebhook('another-secret-here', raw, good)).toBe(false);
            expect(verifyWebhook('s3cret-s3cret-s3cret', `${raw} `, good)).toBe(false);
            expect(verifyWebhook('s3cret-s3cret-s3cret', raw, good.slice('sha256='.length))).toBe(false);
            expect(verifyWebhook('s3cret-s3cret-s3cret', raw, undefined)).toBe(false);
        });

        it('matches BylineAI’s pinned vector (pinionpartners/bylineai#3, computed by openssl and both repos)', () => {
            const body =
                '{"lead_id":"c_0001","email":"jane@acme.com","first_name":"Jane","phone":"+14155550123","country":"US","source_key":"prweb"}';
            const signature = 'sha256=02069c3b3261ed1f1115a58ef34783b6a1658caac3bf1d30e21769be93673f14';
            expect(signWebhook('byline-test-vector-secret', body)).toBe(signature);
            expect(verifyWebhook('byline-test-vector-secret', Buffer.from(body), signature)).toBe(true);
        });

        it('keeps BylineAI’s timestamped ingest scheme as BylineAI has it', () => {
            const sig = signPayload('k', 1_700_000_000, raw);
            expect(
                verifySignature({
                    key: 'k',
                    timestamp: '1700000000',
                    rawBody: raw,
                    signature: sig,
                    nowSec: 1_700_000_100,
                }),
            ).toEqual({ ok: true });
            expect(
                verifySignature({
                    key: 'k',
                    timestamp: '1700000000',
                    rawBody: raw,
                    signature: sig,
                    nowSec: 1_700_001_000,
                }),
            ).toEqual({ ok: false, reason: 'skew' });
        });
    });

    describe('a delivery, read', () => {
        it('takes the connector’s payload, lower-casing the address and dropping blanks and unknowns', () => {
            const parsed = parseLeadPayload({
                lead_id: ' c1 ',
                email: 'Dana@Acme.COM',
                first_name: 'Dana',
                last_name: ' ',
                source_key: 'prweb',
                extra: 1,
            });
            expect(parsed).toEqual({
                ok: true,
                lead: { lead_id: 'c1', email: 'dana@acme.com', first_name: 'Dana', source_key: 'prweb' },
            });
        });

        it('rejects one with no lead id, a bad address, or a field of the wrong type', () => {
            expect(parseLeadPayload({ email: 'a@b.co' })).toMatchObject({ ok: false, reason: 'lead_id is missing' });
            expect(parseLeadPayload({ lead_id: 'x', email: 'nope' })).toMatchObject({ ok: false });
            expect(parseLeadPayload({ lead_id: 'x', email: 'a@b.co', country: 7 })).toMatchObject({
                ok: false,
                reason: 'country is not a string',
            });
            expect(parseLeadPayload([1])).toMatchObject({ ok: false });
        });
    });

    it('records the source as byline:<source_key>, or byline alone', () => {
        expect(bylineSource('prweb')).toBe('byline:prweb');
        expect(bylineSource('Business Wire')).toBe('byline:business_wire');
        expect(bylineSource(undefined)).toBe('byline');
    });

    describe('round robin', () => {
        const [a, b, c] = ['a', 'b', 'c'];

        it('deals in the configured order, then round again', () => {
            const members = new Set([a, b, c]);
            expect([1, 2, 3, 4].map((n) => dealTo([a, b, c], members, n))).toEqual([a, b, c, a]);
        });

        it('skips a member who left, and is null when none is left (the Leads queue)', () => {
            expect([1, 2, 3].map((n) => dealTo([a, b, c], new Set([a, c]), n))).toEqual([a, c, a]);
            expect(dealTo([a, b], new Set(), 1)).toBeNull();
            expect(dealTo([], new Set([a]), 1)).toBeNull();
        });
    });

    it('keeps the raw body for the hooks and the tenant inbound receivers only', () => {
        expect(keepsRawBody('/api/hooks/newswireos/t')).toBe(true);
        expect(keepsRawBody('/api/w/7f1c2a3b-0000-4000-8000-000000000000/inbound/byline')).toBe(true);
        expect(keepsRawBody('/api/w/7f1c2a3b-0000-4000-8000-000000000000/people')).toBe(false);
    });
});

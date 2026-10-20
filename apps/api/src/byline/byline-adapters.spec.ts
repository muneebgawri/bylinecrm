import { describe, expect, it } from 'vitest';
import { errorFrom, ok } from './byline-api.http';
import { findings } from './byline.enricher';
import { leadPhone } from './lead-phone';
import { fromByline } from './byline.verifier';

describe('BYL-2 BylineAI adapters (FR-CRMS-15 enrichment source, FR-CRMS-16 verifier): the pure parts', () => {
    describe('BylineAI’s refusals, surfaced as they are', () => {
        it('a spent budget (402 or budget_exhausted), with BylineAI’s words', () => {
            const e = errorFrom(402, { error: 'budget_exhausted', message: 'monthly cap of $50 reached' });
            expect(e).toMatchObject({
                kind: 'budget',
                message: 'BylineAI’s budget for this is spent: monthly cap of $50 reached',
            });
            expect(errorFrom(200, { error: 'budget_exhausted' }).kind).toBe('budget');
        });

        it('a rate limit, a refused key, anything else', () => {
            expect(errorFrom(429, null).kind).toBe('rate_limited');
            expect(errorFrom(401, null)).toMatchObject({
                kind: 'unauthorized',
                message: 'BylineAI refused the API key (it needs the `lookup` role)',
            });
            expect(errorFrom(500, null)).toMatchObject({ kind: 'unavailable', message: 'BylineAI answered 500' });
        });

        it('its vendors down (503 unavailable): retryable, unlike a spent budget; Nest’s extra fields ignored', () => {
            const e = errorFrom(503, {
                error: 'unavailable',
                message: 'person-enrichment vendors are rate-limited',
                statusCode: 503,
                timestamp: '2026-10-20T00:00:00Z',
                path: '/enrichment/a@b.co',
            });
            expect(e).toMatchObject({
                kind: 'unavailable',
                message:
                    'BylineAI’s enrichment vendors are unavailable; try again later: person-enrichment vendors are rate-limited',
            });
            expect(e.retryable).toBe(true);
            expect(errorFrom(402, { error: 'budget_exhausted', statusCode: 402 }).retryable).toBe(false);
            expect(errorFrom(400, { statusCode: 400, message: ['a', 'b'] }).message).toBe(
                'BylineAI answered 400: a; b',
            );
        });

        it('a 2xx body is read; another status throws', async () => {
            await expect(ok(new Response(JSON.stringify({ a: 1 }), { status: 200 }))).resolves.toEqual({ a: 1 });
            await expect(ok(new Response('{"error":"rate_limited"}', { status: 429 }))).rejects.toMatchObject({
                kind: 'rate_limited',
            });
        });
    });

    describe('enrichment, as findings', () => {
        const found = {
            email: 'dana@acme.com',
            person: {
                firstName: 'Dana',
                lastName: null,
                jobTitle: null,
                country: 'gb',
                linkedinUrl: null,
                avatarUrl: null,
            },
            company: {
                name: 'Acme',
                domain: 'ACME.com',
                linkedinUrl: 'https://linkedin.com/company/acme',
                logoUrl: null,
            },
            confidence: 0.9,
        };

        it('a person’s country, upper case, ranked by BylineAI’s confidence; what it lacks is no answer', () => {
            expect(findings('person', found)).toEqual([
                { field: 'country', status: 'answered', value: 'GB', rank: 2, note: 'BylineAI' },
            ]);
            // A vendor-only match (BylineAI's fixed 0.8) ranks with the free sources.
            expect(findings('person', { ...found, confidence: 0.8 })[0]).toMatchObject({ rank: 1 });
        });

        it('a company’s facts; nothing known is no answer for each', () => {
            expect(
                findings('company', found)
                    .filter((f) => f.status === 'answered')
                    .map((f) => f.field),
            ).toEqual(['name', 'domain', 'linkedin_url']);
            expect(findings('company', null).every((f) => f.status === 'no_answer')).toBe(true);
        });
    });

    describe('verification, in the CRM’s words', () => {
        it('valid is deliverable; invalid and risky keep a known reason; unknown is not decided', () => {
            const base = { email: 'dana@acme.com', provider: 'reacher' };
            expect(fromByline('dana@acme.com', { ...base, verdict: 'valid', reason: null })).toMatchObject({
                result: 'valid',
                reason: 'deliverable',
                source: 'byline',
            });
            expect(fromByline('dana@acme.com', { ...base, verdict: 'risky', reason: 'disposable' })).toMatchObject({
                result: 'risky',
                reason: 'disposable',
            });
            expect(
                fromByline('dana@acme.com', { ...base, verdict: 'invalid', reason: 'mailbox_not_found' }).message,
            ).toContain('mailbox_not_found');
            expect(fromByline('dana@acme.com', { ...base, verdict: 'invalid', reason: 'invalid_format' }).reason).toBe(
                'syntax',
            );
            expect(fromByline('dana@acme.com', { ...base, verdict: 'risky', reason: 'catch_all' }).reason).toBe(
                'catch_all',
            );
            expect(fromByline('dana@acme.com', { ...base, verdict: 'unknown', reason: null })).toMatchObject({
                result: 'unknown',
                reason: 'lookup_failed',
            });
        });
    });

    describe('a lead’s phone (BYL-3)', () => {
        it('E.164 is split at its calling code; a shared one goes to the lead’s country', () => {
            expect(leadPhone('+14155550123', 'US')).toEqual({ number: '4155550123', countryCode: 'US' });
            expect(leadPhone('+14165550123', 'CA')).toEqual({ number: '4165550123', countryCode: 'CA' });
            expect(leadPhone('+44 20 7946 0958', null)).toEqual({ number: '2079460958', countryCode: 'GB' });
        });

        it('dialled digits take the lead’s country; what cannot be parsed is null, for the raw copy', () => {
            expect(leadPhone('020 7946 0958', 'GB')).toEqual({ number: '02079460958', countryCode: 'GB' });
            expect(leadPhone('020 7946 0958', null)).toBeNull();
            expect(leadPhone('call reception', 'GB')).toBeNull();
            expect(leadPhone(undefined, 'GB')).toBeNull();
        });
    });
});

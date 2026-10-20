import { describe, expect, it } from 'vitest';
import { errorFrom, ok } from './byline-api.http';
import { findings } from './byline.enricher';
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
                message: 'BylineAI refused the API key',
            });
            expect(errorFrom(503, null)).toMatchObject({ kind: 'unavailable', message: 'BylineAI answered 503' });
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
                { field: 'avatar_url', status: 'no_answer' },
                { field: 'country', status: 'answered', value: 'GB', rank: 2, note: 'BylineAI' },
            ]);
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
            expect(fromByline('dana@acme.com', { ...base, verdict: 'unknown', reason: null })).toMatchObject({
                result: 'unknown',
                reason: 'lookup_failed',
            });
        });
    });
});

import { describe, expect, it } from 'vitest';
import { covers, settle } from './invoice-decision';
import { parseLookup } from './newswireos-verification.http';
import { NewswireosApiError } from './newswireos-verification.port';

const result = (status: string, reason: string | null = null) =>
    parseLookup({ status, reason_code: reason, canonical_reference: 'pi_1', amount_cents: 100 });

describe('settle (INV-1)', () => {
    it('attaches verified, refuses invalid with the reason', () => {
        expect(settle({ result: result('verified') })).toMatchObject({
            status: 'verified',
            canonicalReference: 'pi_1',
        });
        expect(settle({ result: result('invalid', 'AMOUNT_MISMATCH') })).toMatchObject({
            status: 'invalid',
            reasonCode: 'AMOUNT_MISMATCH',
        });
    });

    it('never passes uncertainty: pending, needs_review and no decision wait for a person', () => {
        expect(settle({ result: result('pending', 'UNDER_CONFIRMED') })).toMatchObject({
            status: 'needs_review',
            reasonCode: 'UNDER_CONFIRMED',
        });
        expect(settle({ result: result('needs_review') })).toMatchObject({
            status: 'needs_review',
            reasonCode: 'NO_DECISION',
        });
        expect(settle({ result: parseLookup({ status: 'maybe' }) })).toMatchObject({ status: 'needs_review' });
        expect(settle({ result: parseLookup(null) })).toMatchObject({ status: 'needs_review' });
    });

    it('retries a transient failure until the last attempt, then waits for a person', () => {
        const down = new NewswireosApiError(null, 'timeout');
        expect(settle({ error: down, finalAttempt: false })).toBe('retry');
        expect(settle({ error: new NewswireosApiError(503, 'x'), finalAttempt: false })).toBe('retry');
        expect(settle({ error: down, finalAttempt: true })).toMatchObject({
            status: 'needs_review',
            reasonCode: 'PROVIDER_ERROR',
        });
    });

    it('a refused token waits for a person; a refused request is invalid', () => {
        expect(settle({ error: new NewswireosApiError(401, 'no'), finalAttempt: false })).toMatchObject({
            status: 'needs_review',
            reasonCode: 'TOKEN_REFUSED',
        });
        expect(settle({ error: new NewswireosApiError(400, 'bad ref'), finalAttempt: false })).toMatchObject({
            status: 'invalid',
            reasonCode: 'BAD_REQUEST',
            facts: { message: 'bad ref' },
        });
    });
});

describe('covers (INV-1)', () => {
    it('adds verified invoices in the deal currency up to its amount', () => {
        const deal = { amountMinor: 1000n, currency: 'USD' };
        expect(covers(deal, [])).toBe(false);
        expect(covers(deal, [{ amountMinor: 600n, currency: 'USD' }])).toBe(false);
        expect(
            covers(deal, [
                { amountMinor: 600n, currency: 'USD' },
                { amountMinor: 400n, currency: 'USD' },
            ]),
        ).toBe(true);
        expect(covers(deal, [{ amountMinor: 5000n, currency: 'EUR' }])).toBe(false);
        expect(covers({ amountMinor: null, currency: 'USD' }, [{ amountMinor: 1n, currency: 'USD' }])).toBe(true);
        // Net of refunds.
        expect(covers(deal, [{ amountMinor: 1000n, refundedAmountMinor: 1n, currency: 'USD' }])).toBe(false);
        expect(covers(deal, [{ amountMinor: 1200n, refundedAmountMinor: 200n, currency: 'USD' }])).toBe(true);
    });
});

import { describe, expect, it } from 'vitest';
import { covers, settle, verifiedTotal } from './invoice-decision';
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

    it('a token without the scope (403) says so; already used waits for a person', () => {
        expect(settle({ error: new NewswireosApiError(403, 'scope'), finalAttempt: false })).toMatchObject({
            status: 'needs_review',
            reasonCode: 'TOKEN_LACKS_SCOPE',
        });
        expect(settle({ result: parseLookup({ status: 'verified', already_used: true }) })).toMatchObject({
            status: 'needs_review',
            reasonCode: 'ALREADY_USED',
        });
        expect(
            settle({ result: parseLookup({ status: 'invalid', reason_code: 'REFUNDED', already_used: true }) }),
        ).toMatchObject({
            status: 'invalid',
            reasonCode: 'REFUNDED',
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

describe('a NewswireOS invoice number (INV-1)', () => {
    const gateway = 'newswireos_invoice';
    it('not found, or a gateway NewswireOS cannot resolve yet, waits for a person, never invalid', () => {
        for (const reason of ['NOT_FOUND', 'UNSUPPORTED_GATEWAY']) {
            expect(settle({ result: result('invalid', reason) }, gateway)).toMatchObject({
                status: 'needs_review',
                reasonCode: 'INVOICE_NUMBER_UNRESOLVED',
                facts: { newswireosReason: reason },
            });
        }
        for (const status of [400, 404, 422]) {
            expect(
                settle({ error: new NewswireosApiError(status, 'unsupported gateway'), finalAttempt: false }, gateway),
            ).toMatchObject({ status: 'needs_review', reasonCode: 'INVOICE_NUMBER_UNRESOLVED' });
        }
    });

    it('a decision NewswireOS did make stands; a gateway id keeps its invalid', () => {
        expect(settle({ result: result('verified') }, gateway)).toMatchObject({ status: 'verified' });
        expect(settle({ result: result('invalid', 'AMOUNT_MISMATCH') }, gateway)).toMatchObject({
            status: 'invalid',
            reasonCode: 'AMOUNT_MISMATCH',
        });
        expect(settle({ result: result('invalid', 'NOT_FOUND') }, 'stripe')).toMatchObject({ status: 'invalid' });
        expect(settle({ error: new NewswireosApiError(null, 'down'), finalAttempt: false }, gateway)).toBe('retry');
    });
});

describe('verifiedTotal (INV-1)', () => {
    it('adds the verified invoices in the currency, net of refunds, never below zero', () => {
        expect(verifiedTotal('USD', [])).toBe(0n);
        expect(
            verifiedTotal('USD', [
                { amountMinor: 1000n, refundedAmountMinor: 200n, currency: 'USD' },
                { amountMinor: 500n, currency: 'USD' },
                { amountMinor: 9000n, currency: 'EUR' },
            ]),
        ).toBe(1300n);
        expect(verifiedTotal('USD', [{ amountMinor: 100n, refundedAmountMinor: 100n, currency: 'USD' }])).toBe(0n);
    });
});

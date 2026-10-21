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

describe('only NewswireOS’s verified counts (INV-1)', () => {
    it('FR-CRMS-19: an unknown, mis-cased or missing status never attaches an invoice; only `verified` does', () => {
        for (const status of ['VERIFIED', 'Verified', 'ok', 'approved', 'paid', '', undefined]) {
            const decision = settle({
                result: parseLookup({ status, reason_code: null, canonical_reference: 'pi_1', amount_cents: 100 }),
            });
            expect(decision === 'retry' ? decision : decision.status, String(status)).not.toBe('verified');
        }
        expect(settle({ result: result('verified') })).toMatchObject({ status: 'verified' });
        // And an invoice that is not verified never covers a deal, whatever its amount.
        expect(covers({ amountMinor: 100n, currency: 'USD' }, [])).toBe(false);
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

describe('a NewswireOS invoice number asked of NewswireOS before #647 (no holder)', () => {
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

describe('the lookup with a holder (newswireos#647)', () => {
    const wire = (body: Record<string, unknown>) =>
        parseLookup({ canonical_reference: 'pi_9', amount_cents: 100, currency: 'usd', ...body });

    it('verified with no holder, or a release of the same client, verifies; the same client is recorded', () => {
        expect(settle({ result: wire({ status: 'verified', holder: 'none', already_used: false }) })).toMatchObject({
            status: 'verified',
            reasonCode: null,
        });
        expect(
            settle({ result: wire({ status: 'verified', holder: 'same_client', already_used: true }) }),
        ).toMatchObject({ status: 'verified', reasonCode: 'HELD_BY_SAME_CLIENT', facts: { holder: 'same_client' } });
    });

    it('another client’s release waits for finance; held (no client named) waits too', () => {
        expect(
            settle({ result: wire({ status: 'verified', holder: 'other_client', already_used: true }) }),
        ).toMatchObject({ status: 'needs_review', reasonCode: 'HELD_BY_OTHER_CLIENT' });
        expect(settle({ result: wire({ status: 'verified', holder: 'held', already_used: true }) })).toMatchObject({
            status: 'needs_review',
            reasonCode: 'ALREADY_USED',
        });
    });

    it('with no holder (an older NewswireOS), already_used decides as before', () => {
        expect(wire({ status: 'verified', already_used: true })).toMatchObject({
            status: 'needs_review',
            reasonCode: 'ALREADY_USED',
            holder: undefined,
        });
    });

    it('a NewswireOS invoice number: its refusals stand as invalid; the real rail and id are kept', () => {
        for (const reason of ['NOT_FOUND', 'INVOICE_VOID', 'INVOICE_UNPAID', 'NO_PROVIDER_PAYMENT']) {
            expect(
                settle(
                    { result: wire({ status: 'invalid', reason_code: reason, holder: 'none' }) },
                    'newswireos_invoice',
                ),
            ).toMatchObject({ status: 'invalid', reasonCode: reason });
        }
        expect(
            settle({ result: wire({ status: 'verified', holder: 'none', gateway: 'stripe' }) }, 'newswireos_invoice'),
        ).toMatchObject({ status: 'verified', canonicalReference: 'pi_9', resolvedGateway: 'stripe' });
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

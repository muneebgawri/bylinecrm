import { isBetterAnswer } from '@bylinecrm/shared';
import { describe, expect, it } from 'vitest';

/**
 * FR-CRMS-15's "overwrites only when better than what is there", per field type (P4-2). `current.rank`
 * is `null` when the value was not written by enrichment — a member's or an import's — and such a
 * value is never replaced; an enrichment-written value is replaced by an answer of equal or higher
 * rank (a source that changed its mind wins over its own older answer). Type-specific tie-breaks:
 * an https URL over http, an apex domain over its `www.` form.
 */
describe('FR-CRMS-15 better than what is there', () => {
    const answer = (value: string, rank = 1) => ({ value, rank });

    it('fills an empty field from any answer, and never replaces a value a member or an import wrote', () => {
        expect(isBetterAnswer('text', answer('Acme'), { value: null, rank: null })).toBe(true);
        expect(isBetterAnswer('text', answer('Acme'), { value: '', rank: null })).toBe(true);
        expect(isBetterAnswer('text', answer('Acme Corporation', 3), { value: 'Acme', rank: null })).toBe(false);
    });

    it('replaces an enrichment-written value with an answer of equal or higher rank, never a lower one', () => {
        expect(isBetterAnswer('text', answer('Acme Corporation', 3), { value: 'Acme', rank: 1 })).toBe(true);
        expect(isBetterAnswer('text', answer('Acme Ltd', 1), { value: 'Acme', rank: 1 })).toBe(true);
        expect(isBetterAnswer('text', answer('acme', 1), { value: 'Acme Corporation', rank: 3 })).toBe(false);
    });

    it('does nothing for the same value', () => {
        expect(isBetterAnswer('text', answer('Acme', 3), { value: 'Acme', rank: 1 })).toBe(false);
    });

    it('prefers https to http at equal rank, and an apex domain to its www. form', () => {
        expect(
            isBetterAnswer('url', answer('https://acme.example/logo.png', 1), {
                value: 'http://acme.example/logo.png',
                rank: 1,
            }),
        ).toBe(true);
        expect(
            isBetterAnswer('url', answer('http://acme.example/logo.png', 1), {
                value: 'https://acme.example/logo.png',
                rank: 1,
            }),
        ).toBe(false);
        expect(isBetterAnswer('domain', answer('acme.example', 1), { value: 'www.acme.example', rank: 1 })).toBe(true);
        expect(isBetterAnswer('domain', answer('www.acme.example', 1), { value: 'acme.example', rank: 1 })).toBe(false);
    });
});

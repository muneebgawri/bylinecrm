import { describe, expect, it } from 'vitest';
import { retryAfterOfGoogleMessage, retryAfterSecondsOf } from './retry-after';

/**
 * When a server says to come back: one reading of it for every client that asks Google (#183, PNW-1125).
 */
describe('retryAfterSecondsOf — a Retry-After header', () => {
    const now = new Date('2026-10-14T10:00:00Z');

    it('reads seconds or an HTTP date, never less than zero, and nothing else', () => {
        expect(retryAfterSecondsOf('120', now)).toBe(120);
        expect(retryAfterSecondsOf('Wed, 14 Oct 2026 10:02:00 GMT', now)).toBe(120);
        expect(retryAfterSecondsOf('Wed, 14 Oct 2026 09:00:00 GMT', now)).toBe(0);
        expect(retryAfterSecondsOf(null, now)).toBeNull();
        expect(retryAfterSecondsOf('soon', now)).toBeNull();
        expect(retryAfterSecondsOf('-5', now)).toBeNull();
    });
});

describe('retryAfterOfGoogleMessage — "Retry after <time>" in a Google error message (PNW-1125)', () => {
    it('reads the time Gmail gives with a per-user rate limit', () => {
        expect(retryAfterOfGoogleMessage('User-rate limit exceeded.  Retry after 2026-10-29T18:12:00.000Z')).toEqual(
            new Date('2026-10-29T18:12:00.000Z'),
        );
        expect(
            retryAfterOfGoogleMessage('Rate Limit Exceeded. retry after 2026-10-30T01:00:00Z (Mail service)'),
        ).toEqual(new Date('2026-10-30T01:00:00Z'));
    });

    it('is no advice when the message names no time, or one that is not a time', () => {
        expect(retryAfterOfGoogleMessage('Rate Limit Exceeded')).toBeNull();
        expect(retryAfterOfGoogleMessage('Retry after tomorrow')).toBeNull();
        expect(retryAfterOfGoogleMessage(null)).toBeNull();
    });
});

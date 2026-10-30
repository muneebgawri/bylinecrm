import { describe, expect, it } from 'vitest';
import { GmailApiError } from './gmail.port';
import { runError } from './mail-sync.service';

/**
 * PNW-1125: what a failed run leaves on the mailbox. It kept only "Gmail refused the sync (403)", so four days of refusals
 * on pr@ and media@ said nothing about WHICH limit Gmail meant or when it would lift. Google's own message (it never
 * holds a token) and its retry time are kept, and the cool-down reads the time.
 */
describe('runError', () => {
    it('keeps Google’s message and its retry time with the reason', () => {
        const retryAfter = new Date('2026-10-29T18:12:00.000Z');
        const record = runError(
            new GmailApiError(
                403,
                'rateLimitExceeded',
                'x',
                'User-rate limit exceeded.  Retry after 2026-10-29T18:12:00.000Z',
                retryAfter,
            ),
        );
        expect(record).toMatchObject({
            code: 'gmail.rateLimitExceeded',
            message: 'Gmail refused the sync (403): User-rate limit exceeded.  Retry after 2026-10-29T18:12:00.000Z',
            retryAfter: '2026-10-29T18:12:00.000Z',
        });
    });

    it('says only the status when Google gave no message, and stores no retry time it did not give', () => {
        const record = runError(new GmailApiError(500, 'backendError', 'x'));
        expect(record.message).toBe('Gmail refused the sync (500)');
        expect('retryAfter' in record).toBe(false);
    });

    it('never stores more of Google’s message than a line', () => {
        const record = runError(new GmailApiError(403, 'rateLimitExceeded', 'x', 'y'.repeat(2000), null));
        expect(record.message.length).toBeLessThanOrEqual(400);
    });
});

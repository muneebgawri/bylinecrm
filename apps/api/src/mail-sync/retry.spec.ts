import { describe, expect, it } from 'vitest';
import { GmailApiError } from './gmail.port';
import { GMAIL_RETRY_ATTEMPTS, GMAIL_RETRY_BASE_MS, GMAIL_RETRY_CAP_MS } from './mail-sync.constants';
import { gmailRetryDelayMs, withGmailRetry } from './retry';

const middle = () => 0.5;

describe('gmailRetryDelayMs', () => {
    it('doubles from the base and stops at the cap', () => {
        expect(gmailRetryDelayMs(1, middle)).toBe(GMAIL_RETRY_BASE_MS);
        expect(gmailRetryDelayMs(2, middle)).toBe(GMAIL_RETRY_BASE_MS * 2);
        expect(gmailRetryDelayMs(3, middle)).toBe(GMAIL_RETRY_BASE_MS * 4);
        expect(gmailRetryDelayMs(30, middle)).toBe(GMAIL_RETRY_CAP_MS);
    });

    it('stays within the jitter band', () => {
        expect(gmailRetryDelayMs(1, () => 0)).toBe(GMAIL_RETRY_BASE_MS * 0.8);
        expect(gmailRetryDelayMs(1, () => 1)).toBe(GMAIL_RETRY_BASE_MS * 1.2);
    });
});

describe('withGmailRetry', () => {
    it('retries 429 and 5xx with the backoff, then succeeds', async () => {
        const waits: number[] = [];
        let calls = 0;
        const result = await withGmailRetry(
            () => {
                calls += 1;
                if (calls === 1) return Promise.reject(new GmailApiError(429, 'rateLimitExceeded', 'slow down'));
                if (calls === 2) return Promise.reject(new GmailApiError(503, 'backendError', 'try later'));
                return Promise.resolve('ok');
            },
            { sleep: (ms) => (waits.push(ms), Promise.resolve()), random: middle },
        );
        expect(result).toBe('ok');
        expect(waits).toEqual([GMAIL_RETRY_BASE_MS, GMAIL_RETRY_BASE_MS * 2]);
    });

    it('gives up after the last attempt', async () => {
        let calls = 0;
        await expect(
            withGmailRetry(
                () => {
                    calls += 1;
                    return Promise.reject(new GmailApiError(500, 'backendError', 'down'));
                },
                { sleep: () => Promise.resolve() },
            ),
        ).rejects.toMatchObject({ status: 500 });
        expect(calls).toBe(GMAIL_RETRY_ATTEMPTS);
    });

    it('does not retry a 404, an auth failure or a non-Gmail error', async () => {
        for (const error of [
            new GmailApiError(404, 'notFound', 'gone'),
            new GmailApiError(401, 'authError', 'no'),
            new Error('bug'),
        ]) {
            let calls = 0;
            await expect(
                withGmailRetry(
                    () => {
                        calls += 1;
                        return Promise.reject(error);
                    },
                    { sleep: () => Promise.resolve() },
                ),
            ).rejects.toBe(error);
            expect(calls).toBe(1);
        }
    });

    it('retries a network failure (no status)', async () => {
        let calls = 0;
        await withGmailRetry(
            () => {
                calls += 1;
                return calls < 2 ? Promise.reject(new GmailApiError(null, 'network', 'reset')) : Promise.resolve(1);
            },
            { sleep: () => Promise.resolve() },
        );
        expect(calls).toBe(2);
    });
});

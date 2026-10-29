import { describe, expect, it, vi } from 'vitest';
import { GmailApiError } from './gmail.port';
import {
    GMAIL_RETRY_ATTEMPTS,
    GMAIL_RETRY_BASE_MS,
    GMAIL_RETRY_CAP_MS,
    MAIL_SYNC_RATE_LIMIT_COOLDOWN_BASE_MS,
    MAIL_SYNC_RATE_LIMIT_COOLDOWN_CAP_MS,
} from './mail-sync.constants';
import { gmailRetryDelayMs, rateLimitCooldownUntil, rateLimitedRuns, withGmailRetry } from './retry';

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

/**
 * Gmail's own guidance for `403 rateLimitExceeded` / `userRateLimitExceeded`: back off exponentially and retry. Treated
 * as permanent, a rate-limited run failed at once — and the tick enqueued the mailbox again two minutes later, every
 * time, so the per-user limit never cleared: the two service inboxes (pr@, media@) failed every sync from 2026-10-25
 * and partner mail stopped reaching NewswireOS.
 */
describe('a rate-limited mailbox', () => {
    it('retries Gmail’s 403 rate limits like a 429, and still not a 403 that is not one', async () => {
        for (const reason of ['rateLimitExceeded', 'userRateLimitExceeded']) {
            let calls = 0;
            const result = await withGmailRetry(
                () => {
                    calls += 1;
                    return calls === 1
                        ? Promise.reject(new GmailApiError(403, reason, 'slow down'))
                        : Promise.resolve('ok');
                },
                { sleep: async () => undefined },
            );
            expect(result).toBe('ok');
            expect(calls).toBe(2);
        }
        let calls = 0;
        await expect(
            withGmailRetry(
                () => {
                    calls += 1;
                    return Promise.reject(new GmailApiError(403, 'insufficientPermissions', 'no'));
                },
                { sleep: async () => undefined },
            ),
        ).rejects.toThrow('no');
        expect(calls).toBe(1);
    });

    it('counts consecutive rate-limited runs, and starts over after any other outcome', () => {
        const limited = { code: 'gmail.rateLimitExceeded', message: 'm', at: '2026-10-28T20:00:00.000Z' };
        expect(rateLimitedRuns(limited, null)).toBe(1);
        expect(rateLimitedRuns(limited, { ...limited, rateLimitedRuns: 3 })).toBe(4);
        expect(rateLimitedRuns(limited, { code: 'internal', message: 'm', at: limited.at })).toBe(1);
        expect(
            rateLimitedRuns({ code: 'internal', message: 'm', at: limited.at }, { ...limited, rateLimitedRuns: 3 }),
        ).toBeUndefined();
    });

    it('cools down exponentially from its last rate-limited run, capped — and not at all otherwise', () => {
        const at = Date.parse('2026-10-28T20:00:00.000Z');
        const record = (n: number) => ({
            code: 'gmail.rateLimitExceeded',
            message: 'm',
            at: new Date(at).toISOString(),
            rateLimitedRuns: n,
        });
        expect(rateLimitCooldownUntil(record(1))).toBe(at + MAIL_SYNC_RATE_LIMIT_COOLDOWN_BASE_MS);
        expect(rateLimitCooldownUntil(record(3))).toBe(at + MAIL_SYNC_RATE_LIMIT_COOLDOWN_BASE_MS * 4);
        expect(rateLimitCooldownUntil(record(30))).toBe(at + MAIL_SYNC_RATE_LIMIT_COOLDOWN_CAP_MS);
        expect(rateLimitCooldownUntil({ code: 'internal', message: 'm', at: new Date(at).toISOString() })).toBe(0);
        expect(rateLimitCooldownUntil(null)).toBe(0);
    });
});

/**
 * PNW-1125: pr@ and media@ were refused by Gmail on every run for four days, the cool-down probing every two hours. Gmail
 * says when a per-user limit lifts ("Retry after <time>"); a request before then is refused anyway and spends quota.
 */
describe('Gmail’s own retry time', () => {
    it('is not retried within the run when Gmail says to wait longer than the run ever waits', async () => {
        const later = new Date(Date.now() + 60 * 60_000);
        const request = vi
            .fn()
            .mockRejectedValue(new GmailApiError(403, 'rateLimitExceeded', 'x', 'Retry after …', later));
        const sleep = vi.fn(async () => undefined);
        await expect(withGmailRetry(request, { sleep })).rejects.toBeInstanceOf(GmailApiError);
        expect(request).toHaveBeenCalledTimes(1);
        expect(sleep).not.toHaveBeenCalled();
    });

    it('still retries a short wait Gmail names, like any transient failure', async () => {
        const soon = new Date(Date.now() + 2_000);
        const request = vi
            .fn()
            .mockRejectedValueOnce(new GmailApiError(429, 'rateLimitExceeded', 'x', null, soon))
            .mockResolvedValue('ok');
        await expect(withGmailRetry(request, { sleep: async () => undefined })).resolves.toBe('ok');
        expect(request).toHaveBeenCalledTimes(2);
    });

    it('holds the mailbox’s cool-down until Gmail’s time when that is later than the backoff', () => {
        const at = '2026-10-29T12:00:00.000Z';
        const retryAfter = '2026-10-29T20:00:00.000Z';
        expect(rateLimitCooldownUntil({ code: 'gmail.rateLimitExceeded', at, rateLimitedRuns: 1, retryAfter })).toBe(
            Date.parse(retryAfter),
        );
        // Earlier than the backoff: the backoff still decides.
        expect(
            rateLimitCooldownUntil({
                code: 'gmail.rateLimitExceeded',
                at,
                rateLimitedRuns: 3,
                retryAfter: '2026-10-29T12:01:00.000Z',
            }),
        ).toBe(Date.parse(at) + 20 * 60_000);
    });
});

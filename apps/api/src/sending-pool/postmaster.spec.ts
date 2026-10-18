import { SENDING_DOMAIN_RECHECK_MS } from '@bylinecrm/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextPostmasterReadAt } from './postmaster-schedule';
import {
    googleErrorOf,
    PostmasterHttp,
    postmasterDay,
    postmasterRange,
    retryAfterSecondsOf,
    spamRateBpsOf,
} from './postmaster.http';
import { PostmasterRequestFailed } from './postmaster.port';

/**
 * Postmaster Tools (P3-2b, #129, #190, FR-CRMS-13): the days a check asks for, and what Google's
 * v2 domain stats answer becomes — a user-reported spam *ratio* (a fraction) read as basis points.
 */
describe('#129 FR-CRMS-13 Postmaster Tools', () => {
    it('asks for yesterday, UTC — Postmaster publishes a day once it is over', () => {
        expect(postmasterDay(new Date('2026-10-12T00:30:00Z'))).toBe('2026-10-11');
        expect(postmasterDay(new Date('2026-01-01T23:59:59Z'))).toBe('2025-12-31');
    });

    it('#190 asks for the 30 days up to yesterday, so a domain’s history fills in one read', () => {
        expect(postmasterRange(new Date('2026-10-18T09:00:00Z'))).toEqual({ from: '2026-09-18', to: '2026-10-17' });
    });

    it('reads the user-reported spam ratio as basis points, rounded, and no ratio as no rate', () => {
        expect(spamRateBpsOf({ doubleValue: 0.0035 })).toBe(35);
        expect(spamRateBpsOf({ floatValue: 0.00301 })).toBe(30);
        expect(spamRateBpsOf({ doubleValue: 0 })).toBe(0);
        expect(spamRateBpsOf({})).toBeNull();
        expect(spamRateBpsOf({ stringValue: 'high' })).toBeNull();
    });

    describe('#183 a 429 is a rate limit, and a day is read once', () => {
        const now = new Date('2026-10-14T10:00:00Z');
        const DAY = 24 * 60 * 60 * 1000;

        it('reads Retry-After as seconds or as a date, and anything else as nothing', () => {
            expect(retryAfterSecondsOf('120', now)).toBe(120);
            expect(retryAfterSecondsOf('Wed, 14 Oct 2026 10:02:00 GMT', now)).toBe(120);
            expect(retryAfterSecondsOf('Wed, 14 Oct 2026 09:00:00 GMT', now)).toBe(0);
            expect(retryAfterSecondsOf(null, now)).toBeNull();
            expect(retryAfterSecondsOf('soon', now)).toBeNull();
            expect(retryAfterSecondsOf('-5', now)).toBeNull();
        });

        it('a reading for the day is enough until the next day, UTC', () => {
            expect(nextPostmasterReadAt({ status: 'ok' }, now, 0)).toEqual(new Date('2026-10-15T00:00:00Z'));
        });

        it('a rate limit or a spent quota waits for Retry-After, else the check cadence doubled per consecutive limit, at most a day', () => {
            for (const status of ['rate_limited', 'quota_exhausted'] as const) {
                expect(nextPostmasterReadAt({ status, retryAfterS: 120 }, now, 0), status).toEqual(
                    new Date(now.getTime() + 120_000),
                );
                expect(nextPostmasterReadAt({ status, retryAfterS: null }, now, 0)).toEqual(
                    new Date(now.getTime() + SENDING_DOMAIN_RECHECK_MS),
                );
                expect(nextPostmasterReadAt({ status, retryAfterS: null }, now, 1)).toEqual(
                    new Date(now.getTime() + 2 * SENDING_DOMAIN_RECHECK_MS),
                );
                expect(nextPostmasterReadAt({ status, retryAfterS: null }, now, 9)).toEqual(
                    new Date(now.getTime() + DAY),
                );
            }
        });

        it('anything transient or refused is tried again at the cadence; nothing connected is nothing to schedule', () => {
            for (const status of ['unreachable', 'failed', 'not_verified'] as const) {
                expect(nextPostmasterReadAt({ status }, now, 3), status).toEqual(
                    new Date(now.getTime() + SENDING_DOMAIN_RECHECK_MS),
                );
            }
            expect(nextPostmasterReadAt({ status: 'not_connected' }, now, 0)).toBeNull();
        });
    });

    describe('#190 Google’s error body is read: its status and message, never a header or the token', () => {
        it('names the quota a RESOURCE_EXHAUSTED body names, and keeps the message to one short line', () => {
            expect(
                googleErrorOf({
                    error: {
                        code: 429,
                        status: 'RESOURCE_EXHAUSTED',
                        message:
                            "Quota exceeded for quota metric 'Queries' and limit 'Queries per day'.\n  Retry later.",
                        details: [
                            {
                                '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
                                reason: 'RATE_LIMIT_EXCEEDED',
                                metadata: {
                                    quota_metric: 'gmailpostmastertools.googleapis.com/queries',
                                    quota_limit: 'QueriesPerDay',
                                },
                            },
                        ],
                    },
                }),
            ).toEqual({
                status: 'RESOURCE_EXHAUSTED',
                message: "Quota exceeded for quota metric 'Queries' and limit 'Queries per day'. Retry later.",
                quotaLimit: 'QueriesPerDay',
            });
            expect(
                googleErrorOf({ error: { status: 'UNAVAILABLE', message: 'x'.repeat(1000) } })?.message,
            ).toHaveLength(300);
            expect(googleErrorOf('<html>Too many requests</html>')).toBeNull();
            expect(googleErrorOf(null)).toBeNull();
        });
    });

    describe('#190 the v2 adapter', () => {
        const token = 'ya29.secret-access-token';
        const http = new PostmasterHttp();
        const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
            new Response(typeof body === 'string' ? body : JSON.stringify(body), {
                status,
                headers: { 'content-type': 'application/json', ...headers },
            });
        const stubFetch = (...replies: Response[]) => {
            const fetch = vi.fn<typeof globalThis.fetch>();
            for (const r of replies) fetch.mockResolvedValueOnce(r);
            vi.stubGlobal('fetch', fetch);
            return fetch;
        };
        afterEach(() => vi.unstubAllGlobals());

        it('queries SPAM_RATE daily over the range and reads each day it answers', async () => {
            const fetch = stubFetch(
                reply(200, {
                    domainStats: [
                        {
                            metric: 'spam_rate',
                            date: { year: 2026, month: 10, day: 16 },
                            value: { doubleValue: 0.0012 },
                        },
                        {
                            metric: 'spam_rate',
                            date: { year: 2026, month: 10, day: 17 },
                            value: { doubleValue: 0.0035 },
                        },
                        { metric: 'spam_rate', date: { year: 2026, month: 10, day: 15 }, value: {} },
                    ],
                }),
            );
            const lookup = await http.spamRates(token, 'Pinionpartners.co', '2026-09-18', '2026-10-17');
            expect(lookup).toEqual({
                status: 'found',
                rates: [
                    { day: '2026-10-16', spamRateBps: 12 },
                    { day: '2026-10-17', spamRateBps: 35 },
                ],
            });
            const [url, init] = fetch.mock.calls[0]!;
            expect(url).toBe(
                'https://gmailpostmastertools.googleapis.com/v2/domains/pinionpartners.co/domainStats:query',
            );
            expect(init?.method).toBe('POST');
            expect(JSON.parse(String(init?.body))).toEqual({
                metricDefinitions: [{ name: 'spam_rate', baseMetric: { standardMetric: 'SPAM_RATE' } }],
                timeQuery: {
                    dateRanges: {
                        dateRanges: [
                            { start: { year: 2026, month: 9, day: 18 }, end: { year: 2026, month: 10, day: 17 } },
                        ],
                    },
                },
                aggregationGranularity: 'DAILY',
                pageSize: 200,
            });
        });

        it('follows the next page until there is none', async () => {
            const day = (d: number, v: number) => ({
                metric: 'spam_rate',
                date: { year: 2026, month: 10, day: d },
                value: { doubleValue: v },
            });
            const fetch = stubFetch(
                reply(200, { domainStats: [day(16, 0.001)], nextPageToken: 'p2' }),
                reply(200, { domainStats: [day(17, 0.002)] }),
            );
            const lookup = await http.spamRates(token, 'x.example', '2026-10-16', '2026-10-17');
            expect(lookup).toMatchObject({ status: 'found', rates: [{ spamRateBps: 10 }, { spamRateBps: 20 }] });
            expect(JSON.parse(String(fetch.mock.calls[1]![1]?.body))).toMatchObject({ pageToken: 'p2' });
        });

        it('a domain with no data is an answer with no days', async () => {
            stubFetch(reply(200, {}));
            expect(await http.spamRates(token, 'x.example', '2026-10-16', '2026-10-17')).toEqual({
                status: 'found',
                rates: [],
            });
        });

        it('a 429 with RESOURCE_EXHAUSTED naming a quota is the quota spent; any other 429 is a rate limit; neither holds the token', async () => {
            stubFetch(
                reply(
                    429,
                    {
                        error: {
                            code: 429,
                            status: 'RESOURCE_EXHAUSTED',
                            message: "Quota exceeded for quota metric 'Queries' and limit 'Queries per day'",
                            details: [
                                {
                                    '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
                                    reason: 'RATE_LIMIT_EXCEEDED',
                                    metadata: { quota_limit: 'QueriesPerDay' },
                                },
                            ],
                        },
                    },
                    { 'retry-after': '60' },
                ),
                reply(429, { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Too many requests' } }),
                reply(429, 'busy'),
            );
            const quota = await http.spamRates(token, 'x.example', '2026-10-16', '2026-10-17');
            expect(quota).toEqual({
                status: 'quota_exhausted',
                retryAfterS: 60,
                google: {
                    status: 'RESOURCE_EXHAUSTED',
                    message: "Quota exceeded for quota metric 'Queries' and limit 'Queries per day'",
                    quotaLimit: 'QueriesPerDay',
                },
            });
            const limited = await http.spamRates(token, 'x.example', '2026-10-16', '2026-10-17');
            expect(limited).toEqual({
                status: 'rate_limited',
                retryAfterS: null,
                google: { status: 'RESOURCE_EXHAUSTED', message: 'Too many requests', quotaLimit: null },
            });
            expect(await http.spamRates(token, 'x.example', '2026-10-16', '2026-10-17')).toEqual({
                status: 'rate_limited',
                retryAfterS: null,
                google: null,
            });
            expect(JSON.stringify([quota, limited])).not.toContain(token);
        });

        it('a 403 or 404 is a domain the account has not verified, with Google’s reason', async () => {
            stubFetch(
                reply(403, {
                    error: { code: 403, status: 'PERMISSION_DENIED', message: 'The caller does not have permission' },
                }),
                reply(404, { error: { code: 404, status: 'NOT_FOUND', message: 'Domain not found' } }),
            );
            expect(await http.spamRates(token, 'x.example', '2026-10-16', '2026-10-17')).toEqual({
                status: 'not_verified',
                google: {
                    status: 'PERMISSION_DENIED',
                    message: 'The caller does not have permission',
                    quotaLimit: null,
                },
            });
            expect(await http.spamRates(token, 'x.example', '2026-10-16', '2026-10-17')).toMatchObject({
                status: 'not_verified',
                google: { status: 'NOT_FOUND' },
            });
        });

        it('any other refusal fails with the status and Google’s own status and message, never the token', async () => {
            stubFetch(reply(500, { error: { code: 500, status: 'INTERNAL', message: 'Internal error encountered.' } }));
            const error = await http.spamRates(token, 'x.example', '2026-10-16', '2026-10-17').catch((e: unknown) => e);
            expect(error).toBeInstanceOf(PostmasterRequestFailed);
            const failed = error as PostmasterRequestFailed;
            expect(failed.status).toBe(500);
            expect(failed.message).toContain('INTERNAL');
            expect(failed.message).toContain('Internal error encountered.');
            expect(failed.message).not.toContain(token);
        });

        it('lists the account’s domains, every page, with whether each is verified', async () => {
            const fetch = stubFetch(
                reply(200, {
                    domains: [
                        { name: 'domains/Pinionpartners.co', verificationState: 'VERIFIED', permission: 'OWNER' },
                    ],
                    nextPageToken: 'n',
                }),
                reply(200, { domains: [{ name: 'domains/pinionnewswire.com', verificationState: 'UNVERIFIED' }] }),
            );
            expect(await http.domains(token)).toEqual([
                { domain: 'pinionpartners.co', verified: true },
                { domain: 'pinionnewswire.com', verified: false },
            ]);
            expect(String(fetch.mock.calls[0]![0])).toBe(
                'https://gmailpostmastertools.googleapis.com/v2/domains?pageSize=200',
            );
            expect(String(fetch.mock.calls[1]![0])).toContain('pageToken=n');
            expect(fetch.mock.calls[0]![1]?.headers).toEqual({ authorization: `Bearer ${token}` });
        });

        it('a refused listing fails with Google’s status and message', async () => {
            stubFetch(reply(429, { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded' } }));
            await expect(http.domains(token)).rejects.toThrow(/429.*RESOURCE_EXHAUSTED.*Quota exceeded/);
        });
    });
});

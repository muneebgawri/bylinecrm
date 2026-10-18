import { Injectable } from '@nestjs/common';
import { SPAM_RATE_HISTORY_DAYS } from '@bylinecrm/shared';
import { z } from 'zod';
import { assertNoOpenTransaction } from '../infra/transaction-scope';
import {
    PostmasterRequestFailed,
    type DaySpamRate,
    type GoogleErrorDetail,
    type PostmasterDomain,
    type PostmasterPort,
    type SpamRatesLookup,
} from './postmaster.port';
import {
    POSTMASTER_ENDPOINT,
    POSTMASTER_ERROR_MESSAGE_MAX,
    POSTMASTER_HTTP_TIMEOUT_MS,
    POSTMASTER_MAX_PAGES,
    POSTMASTER_PAGE_SIZE,
} from './sending-pool.constants';

/**
 * The day a check asks Postmaster Tools for: yesterday, UTC, as `YYYY-MM-DD`. Google publishes a
 * day's stats once the day is over; asking for today answers "no data" until tomorrow.
 */
export function postmasterDay(now: Date): string {
    return utcDay(now, -1);
}

/**
 * The days a read asks for (#190): the `SPAM_RATE_HISTORY_DAYS` days up to yesterday, UTC — one
 * request fills a domain's history, and the day a pause is judged on is the last of them.
 */
export function postmasterRange(now: Date): { from: string; to: string } {
    return { from: utcDay(now, -SPAM_RATE_HISTORY_DAYS), to: utcDay(now, -1) };
}

function utcDay(now: Date, offset: number): string {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offset))
        .toISOString()
        .slice(0, 10);
}

/**
 * A user-reported spam rate, as basis points: Google's `SPAM_RATE` statistic is a fraction
 * (0.0035 = 0.35%), as v1's `userReportedSpamRatio` was. A value without a number has no rate.
 */
export function spamRateBpsOf(value: Record<string, unknown>): number | null {
    const ratio = value['doubleValue'] ?? value['floatValue'];
    if (typeof ratio !== 'number' || !Number.isFinite(ratio)) return null;
    return Math.round(ratio * 10_000);
}

/**
 * A `Retry-After` header as the seconds to wait (#183): a number of seconds, or an HTTP date (how
 * far it is from `now`, never less than zero). Anything else, or no header, is no advice.
 */
export function retryAfterSecondsOf(header: string | null, now: Date): number | null {
    if (header === null) return null;
    const value = header.trim();
    // A delta in seconds, or an HTTP date; a negative delta (or a bare number parsed as a year) is neither.
    if (/^-?\d+$/.test(value)) return value.startsWith('-') ? null : Number(value);
    const at = Date.parse(value);
    if (Number.isNaN(at)) return null;
    return Math.max(0, Math.round((at - now.getTime()) / 1000));
}

const googleError = z.object({
    error: z.object({
        status: z.string().optional(),
        message: z.string().optional(),
        details: z.array(z.object({ metadata: z.record(z.string(), z.unknown()).optional() }).passthrough()).optional(),
    }),
});

/**
 * What Google's JSON error body says (#190): `{ error: { status, message, details } }`, the
 * message on one line and at most `POSTMASTER_ERROR_MESSAGE_MAX` characters, and the quota limit an
 * `ErrorInfo` detail names (`quota_limit`, else `quota_metric`). Anything else is nothing.
 */
export function googleErrorOf(body: unknown): GoogleErrorDetail | null {
    const parsed = googleError.safeParse(body);
    if (!parsed.success) return null;
    const { status, message, details } = parsed.data.error;
    const quota = details
        ?.map((d) => d.metadata?.['quota_limit'] ?? d.metadata?.['quota_metric'])
        .find((q): q is string => typeof q === 'string' && q !== '');
    const line = message?.replace(/\s+/g, ' ').trim().slice(0, POSTMASTER_ERROR_MESSAGE_MAX);
    return { status: status ?? null, message: line || null, quotaLimit: quota ?? null };
}

const domainStats = z.object({
    domainStats: z
        .array(
            z.object({
                date: z.object({ year: z.number(), month: z.number(), day: z.number() }).optional(),
                value: z.object({ doubleValue: z.number().optional(), floatValue: z.number().optional() }).optional(),
            }),
        )
        .optional(),
    nextPageToken: z.string().optional(),
});

const domainList = z.object({
    domains: z.array(z.object({ name: z.string() })).optional(),
    nextPageToken: z.string().optional(),
});

const SPAM_RATE_METRIC = 'spam_rate';

/** `YYYY-MM-DD` as Google's `Date` message. */
function googleDate(day: string): { year: number; month: number; day: number } {
    const [year, month, date] = day.split('-').map(Number) as [number, number, number];
    return { year, month, day: date };
}

/**
 * The port, over HTTPS to the Postmaster Tools API v2 (#190; v1's `trafficStats` is being retired):
 * `GET /v2/domains` for the account's domains and `POST /v2/domains/{domain}/domainStats:query` for
 * a domain's daily `SPAM_RATE`, each with a timeout, every page followed. A reply Google's
 * documentation gives a meaning to (403/404 — not the account's domain, 429 — the quota said not
 * now, or is spent) is a lookup result; anything else is a failure. Google's error body is read for
 * its status and message (`googleErrorOf`); no header and never the token is kept.
 */
@Injectable()
export class PostmasterHttp implements PostmasterPort {
    async domains(accessToken: string): Promise<PostmasterDomain[]> {
        assertNoOpenTransaction('Postmaster domains');
        const found: PostmasterDomain[] = [];
        let pageToken: string | undefined;
        for (let page = 0; page < POSTMASTER_MAX_PAGES; page += 1) {
            const query = new URLSearchParams({ pageSize: String(POSTMASTER_PAGE_SIZE) });
            if (pageToken) query.set('pageToken', pageToken);
            const res = await this.call('the account', `${POSTMASTER_ENDPOINT}/domains?${query}`, accessToken);
            if (!res.ok) throw await this.refused('the account', res);
            const parsed = domainList.safeParse(await this.json('the account', res));
            if (!parsed.success)
                throw new PostmasterRequestFailed('the account', res.status, 'the answer had an unexpected shape');
            for (const d of parsed.data.domains ?? []) {
                found.push({ domain: d.name.replace(/^domains\//, '').toLowerCase() });
            }
            pageToken = parsed.data.nextPageToken || undefined;
            if (!pageToken) break;
        }
        return found;
    }

    async spamRates(accessToken: string, domain: string, from: string, to: string): Promise<SpamRatesLookup> {
        assertNoOpenTransaction('Postmaster spamRates');
        const name = domain.toLowerCase();
        const url = `${POSTMASTER_ENDPOINT}/domains/${encodeURIComponent(name)}/domainStats:query`;
        const rates: DaySpamRate[] = [];
        let pageToken: string | undefined;
        for (let page = 0; page < POSTMASTER_MAX_PAGES; page += 1) {
            const res = await this.call(name, url, accessToken, {
                metricDefinitions: [{ name: SPAM_RATE_METRIC, baseMetric: { standardMetric: 'SPAM_RATE' } }],
                timeQuery: { dateRanges: { dateRanges: [{ start: googleDate(from), end: googleDate(to) }] } },
                aggregationGranularity: 'DAILY',
                pageSize: POSTMASTER_PAGE_SIZE,
                ...(pageToken ? { pageToken } : {}),
            });
            if (res.status === 403 || res.status === 404) {
                return { status: 'not_verified', google: googleErrorOf(await this.bodyOf(res)) };
            }
            if (res.status === 429) {
                const google = googleErrorOf(await this.bodyOf(res));
                const retryAfterS = retryAfterSecondsOf(res.headers.get('retry-after'), new Date());
                return google?.status === 'RESOURCE_EXHAUSTED' && google.quotaLimit
                    ? { status: 'quota_exhausted', retryAfterS, google }
                    : { status: 'rate_limited', retryAfterS, google };
            }
            if (!res.ok) throw await this.refused(name, res);
            const parsed = domainStats.safeParse(await this.json(name, res));
            if (!parsed.success)
                throw new PostmasterRequestFailed(name, res.status, 'the answer had an unexpected shape');
            for (const stat of parsed.data.domainStats ?? []) {
                const bps = stat.value ? spamRateBpsOf(stat.value) : null;
                if (!stat.date || bps === null) continue;
                const { year, month, day } = stat.date;
                rates.push({
                    day: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
                    spamRateBps: bps,
                });
            }
            pageToken = parsed.data.nextPageToken || undefined;
            if (!pageToken) break;
        }
        rates.sort((a, b) => a.day.localeCompare(b.day));
        return { status: 'found', rates };
    }

    // ── Internals ────────────────────────────────────────────────────────────────────────────

    /** One request with the token and a timeout; no answer at all is a failure with status 0. */
    private async call(subject: string, url: string, accessToken: string, body?: unknown): Promise<Response> {
        try {
            return await fetch(url, {
                method: body === undefined ? 'GET' : 'POST',
                headers:
                    body === undefined
                        ? { authorization: `Bearer ${accessToken}` }
                        : { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                signal: AbortSignal.timeout(POSTMASTER_HTTP_TIMEOUT_MS),
            });
        } catch {
            throw new PostmasterRequestFailed(subject, 0, 'no answer within the timeout');
        }
    }

    private async json(subject: string, res: Response): Promise<unknown> {
        try {
            return await res.json();
        } catch {
            throw new PostmasterRequestFailed(subject, res.status, 'the answer was not JSON');
        }
    }

    /** An error reply's body, when it is JSON; nothing otherwise (an HTML page from a proxy). */
    private async bodyOf(res: Response): Promise<unknown> {
        try {
            return await res.json();
        } catch {
            return null;
        }
    }

    private async refused(subject: string, res: Response): Promise<PostmasterRequestFailed> {
        return new PostmasterRequestFailed(
            subject,
            res.status,
            'the request was refused',
            googleErrorOf(await this.bodyOf(res)),
        );
    }
}

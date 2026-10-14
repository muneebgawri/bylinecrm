import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { assertNoOpenTransaction } from '../infra/transaction-scope';
import { PostmasterRequestFailed, type PostmasterPort, type TrafficStatsLookup } from './postmaster.port';
import { POSTMASTER_ENDPOINT, POSTMASTER_HTTP_TIMEOUT_MS } from './sending-pool.constants';

/**
 * The day a check asks Postmaster Tools for: yesterday, UTC, as `YYYY-MM-DD`. Google publishes a
 * day's stats once the day is over; asking for today answers "no data" until tomorrow.
 */
export function postmasterDay(now: Date): string {
    const yesterday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
    return yesterday.toISOString().slice(0, 10);
}

/**
 * The user-reported spam rate a `TrafficStats` record carries, as basis points: Google gives
 * `userReportedSpamRatio` as a fraction (0.0035 = 0.35%). A record without one — Google omits the
 * field below its traffic minimum — has no rate.
 */
export function spamRateBpsOf(record: { userReportedSpamRatio?: unknown }): number | null {
    const ratio = record.userReportedSpamRatio;
    if (typeof ratio !== 'number' || !Number.isFinite(ratio)) return null;
    return Math.round(ratio * 10_000);
}

const trafficStats = z.object({ userReportedSpamRatio: z.number().optional() }).passthrough();

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

/**
 * The port, over HTTPS to the Postmaster Tools API (`GET /v1/domains/{domain}/trafficStats/{YYYYMMDD}`).
 * One request per check, with a timeout; a reply Google's documentation gives a meaning to (403 —
 * not verified, 404 — no data for the day, 429 — the quota is spent for now, #183) is a lookup
 * result; anything else is a failure that names the status and nothing Google wrote (its error
 * text is free form and stays out of logs).
 */
@Injectable()
export class PostmasterHttp implements PostmasterPort {
    async trafficStats(accessToken: string, domain: string, day: string): Promise<TrafficStatsLookup> {
        assertNoOpenTransaction('Postmaster trafficStats');
        const url = `${POSTMASTER_ENDPOINT}/domains/${encodeURIComponent(domain)}/trafficStats/${day.replaceAll('-', '')}`;
        let res: Response;
        try {
            res = await fetch(url, {
                headers: { authorization: `Bearer ${accessToken}` },
                signal: AbortSignal.timeout(POSTMASTER_HTTP_TIMEOUT_MS),
            });
        } catch {
            throw new PostmasterRequestFailed(domain, 0, 'no answer within the timeout');
        }
        if (res.status === 403) return { status: 'not_verified' };
        if (res.status === 404) return { status: 'no_data', day };
        if (res.status === 429) {
            return {
                status: 'rate_limited',
                retryAfterS: retryAfterSecondsOf(res.headers.get('retry-after'), new Date()),
            };
        }
        if (!res.ok) throw new PostmasterRequestFailed(domain, res.status, 'the request was refused');
        let body: unknown;
        try {
            body = await res.json();
        } catch {
            throw new PostmasterRequestFailed(domain, res.status, 'the answer was not JSON');
        }
        const parsed = trafficStats.safeParse(body);
        if (!parsed.success)
            throw new PostmasterRequestFailed(domain, res.status, 'the answer had an unexpected shape');
        return { status: 'found', day, spamRateBps: spamRateBpsOf(parsed.data) };
    }
}

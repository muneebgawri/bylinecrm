import { NO_TRACKING_COUNTS, type TrackingCounts } from '@bylinecrm/shared';
import { Prisma } from '@prisma/client';
import type { WorkspaceClient } from '../infra/rls-prisma.service';

/**
 * The counts a listing shows (P3-4): clicks, distinct links clicked, and indicative opens, per send
 * or per sequence step, from the hits that are not a scanner's. One query for a page of rows; a
 * listing adds it to the view it already builds — there is no counter to keep in step.
 */
async function countsBy(
    tx: WorkspaceClient,
    column: 'outbound_id' | 'sequence_step_id',
    ids: readonly string[],
): Promise<Map<string, TrackingCounts>> {
    const out = new Map<string, TrackingCounts>();
    if (ids.length === 0) return out;
    const rows = await tx.$queryRaw<{ id: string; kind: 'click' | 'open'; hits: number; tokens: number }[]>`
        SELECT ${Prisma.raw(column)} AS id, kind, count(*)::int AS hits, count(DISTINCT token_id)::int AS tokens
        FROM tracking_hits
        WHERE bot_reason IS NULL AND ${Prisma.raw(column)} = ANY(${[...ids]}::uuid[])
        GROUP BY ${Prisma.raw(column)}, kind`;
    for (const row of rows) {
        const counts = out.get(row.id) ?? { ...NO_TRACKING_COUNTS };
        if (row.kind === 'click') {
            counts.clicks = row.hits;
            counts.uniqueClicks = row.tokens;
        } else {
            counts.opens = row.hits;
        }
        out.set(row.id, counts);
    }
    return out;
}

/** Per send. */
export function trackingCountsForSends(
    tx: WorkspaceClient,
    ids: readonly string[],
): Promise<Map<string, TrackingCounts>> {
    return countsBy(tx, 'outbound_id', ids);
}

/** Per sequence step. */
export function trackingCountsForSteps(
    tx: WorkspaceClient,
    ids: readonly string[],
): Promise<Map<string, TrackingCounts>> {
    return countsBy(tx, 'sequence_step_id', ids);
}

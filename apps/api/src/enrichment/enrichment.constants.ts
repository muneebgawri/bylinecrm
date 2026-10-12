import type { EnrichmentObject } from '@bylinecrm/shared';

/** The queue a record's enrichment runs on (P4-2): one job per record, whatever asked for it. */
export const ENRICHMENT_QUEUE = 'enrichment';
export const ENRICHMENT_JOB_ATTEMPTS = 3;
export const ENRICHMENT_JOB_BACKOFF_MS = 30_000;
/** A job holds its lock this long: the sources' timeouts added up, with room. */
export const ENRICHMENT_LOCK_MS = 2 * 60_000;
export const ENRICHMENT_WORKER_CONCURRENCY = 2;

/** One job per record; a second ask while one waits is the same job. (BullMQ reserves `:` in ids.) */
export function enrichmentJobId(object: EnrichmentObject, recordId: string): string {
    return `${object}.${recordId}`;
}

/** The repeating sweep that queues records whose answers are older than their workspace's age. */
export const ENRICHMENT_MAINTENANCE_QUEUE = 'enrichment-maintenance';
export const ENRICHMENT_SWEEP_EVERY_MS = 60 * 60_000;
/** Records one pass queues at most, the longest unasked first; the next pass takes the next. */
export const ENRICHMENT_SWEEP_BATCH = 100;

/** Sources asked at once for one record. */
export const ENRICHMENT_SOURCE_CONCURRENCY = 2;

/** A page is read up to this many bytes: a home page's head and footer are what the sources need. */
export const ENRICHMENT_FETCH_MAX_BYTES = 512 * 1024;
export const ENRICHMENT_FETCH_REDIRECTS = 3;
export const ENRICHMENT_USER_AGENT = 'BylineCRM-Enricher/1 (+https://bylinecrm.com)';

/** The people of a company whose addresses the email-addresses source reads, at most. */
export const ENRICHMENT_PEOPLE_SAMPLE = 200;

import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { EnrichmentObject } from '@bylinecrm/shared';
import { Queue } from 'bullmq';
import { ENRICHMENT_QUEUE, enrichmentJobId } from './enrichment.constants';

/** A record's enrichment job; `force` asks every source again whatever its age (_Enrich now_). */
export interface EnrichmentJob {
    workspaceId: string;
    object: EnrichmentObject;
    recordId: string;
    force: boolean;
}

export const ENRICH_JOB = 'enrich';

/**
 * The one way a record gets on the enrichment queue (P4-2) — _Enrich now_, the outbox consumer on a
 * new or changed record, the re-ask sweep. One job per record: a second ask while one waits is the
 * same job; a forced ask replaces a waiting unforced one. Never throws: Redis down is logged, and
 * the sweep asks again next hour.
 */
@Injectable()
export class EnrichmentQueue {
    private readonly logger = new Logger(EnrichmentQueue.name);

    constructor(@InjectQueue(ENRICHMENT_QUEUE) private readonly queue: Queue<EnrichmentJob>) {}

    /** Queues the record; `false` when a job for it already waits or runs. */
    async enqueue(job: EnrichmentJob): Promise<boolean> {
        const id = enrichmentJobId(job.object, job.recordId);
        try {
            const existing = await this.queue.getJob(id);
            if (existing) {
                const state = await existing.getState();
                if (state === 'active') return false;
                if ((state === 'waiting' || state === 'delayed') && (!job.force || existing.data.force)) return false;
                await existing.remove();
            }
            await this.queue.add(ENRICH_JOB, job, { jobId: id });
            return true;
        } catch (error) {
            this.logger.error(`could not queue enrichment of ${id}: ${describe(error)}`);
            return false;
        }
    }

    /** Whether the record's job waits or runs now. */
    async isPending(object: EnrichmentObject, recordId: string): Promise<boolean> {
        try {
            const job = await this.queue.getJob(enrichmentJobId(object, recordId));
            if (!job) return false;
            const state = await job.getState();
            return state === 'waiting' || state === 'active' || state === 'delayed' || state === 'prioritized';
        } catch {
            return false;
        }
    }
}

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

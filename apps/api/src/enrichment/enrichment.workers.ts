import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue, Worker, type Job } from 'bullmq';
import { ENV, type Env } from '../config/env';
import { ENRICH_JOB, type EnrichmentJob } from './enrichment-queue';
import { EnrichmentRunner } from './enrichment-runner';
import { EnrichmentSweep } from './enrichment-sweep';
import {
    ENRICHMENT_LOCK_MS,
    ENRICHMENT_MAINTENANCE_QUEUE,
    ENRICHMENT_QUEUE,
    ENRICHMENT_SWEEP_EVERY_MS,
    ENRICHMENT_WORKER_CONCURRENCY,
} from './enrichment.constants';

const SWEEP_JOB = 'sweep';

/**
 * Runs enrichment jobs (in a worker process, `ENRICHMENT_WORKER`) on the background pool, and the
 * hourly re-ask sweep beside them. A job that throws (the database, Redis) is retried by the queue's
 * backoff; the sources' own failures are not throws — they are kept as failed answers.
 */
@Injectable()
export class EnrichmentWorkers implements OnApplicationBootstrap, OnModuleDestroy {
    private readonly logger = new Logger(EnrichmentWorkers.name);
    private readonly workers: Worker[] = [];

    constructor(
        @Inject(ENV) private readonly env: Env,
        private readonly runner: EnrichmentRunner,
        private readonly sweep: EnrichmentSweep,
        @InjectQueue(ENRICHMENT_MAINTENANCE_QUEUE) private readonly maintenance: Queue,
    ) {}

    async onApplicationBootstrap(): Promise<void> {
        if (!this.env.ENRICHMENT_WORKER) return;
        const connection = { url: this.env.REDIS_URL, maxRetriesPerRequest: null };
        this.workers.push(
            this.watch(
                new Worker<EnrichmentJob>(ENRICHMENT_QUEUE, (job) => this.process(job), {
                    connection,
                    concurrency: ENRICHMENT_WORKER_CONCURRENCY,
                    lockDuration: ENRICHMENT_LOCK_MS,
                }),
            ),
            this.watch(
                new Worker(
                    ENRICHMENT_MAINTENANCE_QUEUE,
                    async (job) => {
                        if (job.name === SWEEP_JOB) await this.sweep.run();
                    },
                    { connection },
                ),
            ),
        );
        await this.maintenance.upsertJobScheduler(SWEEP_JOB, { every: ENRICHMENT_SWEEP_EVERY_MS }, { name: SWEEP_JOB });
    }

    async onModuleDestroy(): Promise<void> {
        await Promise.all(this.workers.map((w) => w.close()));
    }

    private async process(job: Job<EnrichmentJob>): Promise<void> {
        if (job.name !== ENRICH_JOB) return;
        const { workspaceId, object, recordId, force } = job.data;
        await this.runner.enrich(workspaceId, object, recordId, { force });
    }

    private watch<T extends Worker>(worker: T): T {
        worker.on('error', (error) => this.logger.error(`worker ${worker.name}: ${error.message}`));
        return worker;
    }
}

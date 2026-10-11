import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue, Worker, type Job } from 'bullmq';
import { ENV, type Env } from '../config/env';
import { SequenceRunner, type SequenceStepJob } from './sequence-runner';
import { SequenceSweep } from './sequence-sweep';
import {
    SEQUENCE_MAINTENANCE_QUEUE,
    SEQUENCE_STEP_QUEUE,
    SEQUENCE_SWEEP_EVERY_MS,
    SEQUENCE_WORKER_CONCURRENCY,
} from './sequences.constants';

const SWEEP_JOB = 'sweep';

/**
 * Runs due steps (in a worker process, `SEQUENCE_WORKER`) and the sweep under them, which repeats on
 * the maintenance queue and runs once at start. A step that throws (the database, Redis) is retried by
 * the queue's backoff; its row is untouched until a run succeeds, and the sweep re-adds a job lost for good.
 */
@Injectable()
export class SequenceWorkers implements OnApplicationBootstrap, OnModuleDestroy {
    private readonly logger = new Logger(SequenceWorkers.name);
    private readonly workers: Worker[] = [];

    constructor(
        @Inject(ENV) private readonly env: Env,
        private readonly runner: SequenceRunner,
        private readonly sweep: SequenceSweep,
        @InjectQueue(SEQUENCE_MAINTENANCE_QUEUE) private readonly maintenance: Queue,
    ) {}

    async onApplicationBootstrap(): Promise<void> {
        if (!this.env.SEQUENCE_WORKER) return;
        const connection = { url: this.env.REDIS_URL, maxRetriesPerRequest: null };
        this.workers.push(
            this.watch(
                new Worker(SEQUENCE_STEP_QUEUE, (job: Job<SequenceStepJob>) => this.step(job.data), {
                    connection,
                    concurrency: SEQUENCE_WORKER_CONCURRENCY,
                }),
            ),
            this.watch(
                new Worker(
                    SEQUENCE_MAINTENANCE_QUEUE,
                    async (job) => {
                        if (job.name === SWEEP_JOB) await this.sweep.run();
                    },
                    { connection },
                ),
            ),
        );
        await this.maintenance.upsertJobScheduler(SWEEP_JOB, { every: SEQUENCE_SWEEP_EVERY_MS }, { name: SWEEP_JOB });
        await this.sweep.run().catch((error: unknown) => {
            this.logger.error(
                `startup sequence sweep failed: ${error instanceof Error ? error.message : String(error)}`,
            );
        });
    }

    async onModuleDestroy(): Promise<void> {
        await Promise.all(this.workers.map((w) => w.close()));
    }

    private step(data: SequenceStepJob): Promise<unknown> {
        return this.runner.run(data.workspaceId, data.enrolmentId, new Date(), new Date(data.at));
    }

    private watch<T extends Worker>(worker: T): T {
        worker.on('error', (error) => this.logger.error(`worker ${worker.name}: ${error.message}`));
        return worker;
    }
}

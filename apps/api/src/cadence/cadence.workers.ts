import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue, Worker } from 'bullmq';
import { ENV, type Env } from '../config/env';
import { CadenceService } from './cadence.service';

/** The queue the hourly cadence job runs on, its name and its schedule (CADENCE-1). */
export const CADENCE_QUEUE = 'cadence-maintenance';
export const CADENCE_JOB = 'cadence-rotation';
export const CADENCE_CRON = '0 * * * *';

/**
 * The hourly cadence job (CADENCE-1): refresh, warn, rotate — in the notifications worker process
 * (`NOTIFICATIONS_WORKER`), beside the other repeating jobs that tell members things. Idempotent: a run repeated
 * warns nobody twice and rotates nothing twice.
 */
@Injectable()
export class CadenceWorkers implements OnApplicationBootstrap, OnModuleDestroy {
    private readonly logger = new Logger(CadenceWorkers.name);
    private worker: Worker | null = null;

    constructor(
        @Inject(ENV) private readonly env: Env,
        private readonly cadence: CadenceService,
        @InjectQueue(CADENCE_QUEUE) private readonly queue: Queue,
    ) {}

    async onApplicationBootstrap(): Promise<void> {
        if (!this.env.NOTIFICATIONS_WORKER) return;
        this.worker = new Worker(
            CADENCE_QUEUE,
            async (job) => {
                if (job.name === CADENCE_JOB) await this.cadence.runAll();
            },
            { connection: { url: this.env.REDIS_URL, maxRetriesPerRequest: null } },
        );
        this.worker.on('error', (error) => this.logger.error(`worker ${CADENCE_QUEUE}: ${error.message}`));
        await this.queue.upsertJobScheduler(CADENCE_JOB, { pattern: CADENCE_CRON, tz: 'UTC' }, { name: CADENCE_JOB });
    }

    async onModuleDestroy(): Promise<void> {
        await this.worker?.close();
    }
}

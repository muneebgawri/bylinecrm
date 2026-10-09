import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue, Worker } from 'bullmq';
import { ENV, type Env } from '../config/env';
import { WebhooksRetention } from './retention.processor';
import { WebhooksSweep } from './sweep';
import {
    WEBHOOK_MAINTENANCE_QUEUE,
    WEBHOOK_QUEUE,
    WEBHOOK_RETENTION_EVERY_MS,
    WEBHOOK_SWEEP_EVERY_MS,
    WEBHOOK_WORKER_CONCURRENCY,
    backoffDelayMs,
} from './webhooks.constants';
import { RetryableDeliveryError, WebhooksProcessor } from './webhooks.processor';
import type { DeliveryJob } from './webhooks.service';

/** The maintenance queue's two repeating jobs, told apart by name. */
const RETENTION_JOB = 'retention';
const SWEEP_JOB = 'sweep';

/**
 * Starts the delivery worker and the maintenance worker (retention, and the stranded-delivery
 * sweep, which also runs once at start) when this process is a worker (`WEBHOOK_WORKER`), after
 * the application has booted, and stops them on shutdown. Read from the injected environment at
 * runtime, so a process that only compiles the application (the OpenAPI writer, the router walk)
 * never starts one, and a deployment can run the same image as an API without workers and as a
 * worker. The schedules are idempotent, so several workers share one.
 */
@Injectable()
export class WebhookWorkers implements OnApplicationBootstrap, OnModuleDestroy {
    private readonly logger = new Logger(WebhookWorkers.name);
    private readonly workers: Worker[] = [];

    constructor(
        @Inject(ENV) private readonly env: Env,
        private readonly deliveries: WebhooksProcessor,
        private readonly retention: WebhooksRetention,
        private readonly sweep: WebhooksSweep,
        @InjectQueue(WEBHOOK_MAINTENANCE_QUEUE) private readonly maintenance: Queue,
    ) {}

    async onApplicationBootstrap(): Promise<void> {
        if (!this.env.WEBHOOK_WORKER) return;
        const connection = { url: this.env.REDIS_URL, maxRetriesPerRequest: null };
        this.workers.push(
            this.watch(
                new Worker<DeliveryJob>(WEBHOOK_QUEUE, (job, token) => this.deliveries.process(job, token), {
                    connection,
                    concurrency: WEBHOOK_WORKER_CONCURRENCY,
                    // The wait is the one the service computed from the row; the fallback only
                    // covers an error that is not a delivery's own (a lost Redis connection mid-job).
                    settings: {
                        backoffStrategy: (attemptsMade: number, _type?: string, error?: Error) =>
                            error instanceof RetryableDeliveryError ? error.retryDelayMs : backoffDelayMs(attemptsMade),
                    },
                }),
            ),
            this.watch(new Worker(WEBHOOK_MAINTENANCE_QUEUE, (job) => this.maintain(job.name), { connection })),
        );
        await this.maintenance.upsertJobScheduler(
            RETENTION_JOB,
            { every: WEBHOOK_RETENTION_EVERY_MS },
            { name: RETENTION_JOB },
        );
        await this.maintenance.upsertJobScheduler(SWEEP_JOB, { every: WEBHOOK_SWEEP_EVERY_MS }, { name: SWEEP_JOB });
        // Once now, so deliveries stranded while no worker ran are picked up at start, not on the next tick.
        await this.sweep.run().catch((error: unknown) => {
            this.logger.error(`startup sweep failed: ${error instanceof Error ? error.message : String(error)}`);
        });
    }

    async onModuleDestroy(): Promise<void> {
        await Promise.all(this.workers.map((worker) => worker.close()));
    }

    private async maintain(name: string): Promise<void> {
        if (name === RETENTION_JOB) await this.retention.prune();
        else if (name === SWEEP_JOB) await this.sweep.run();
        else this.logger.warn(`maintenance job ${name} is not one this worker knows`);
    }

    /** A worker without an error listener turns a Redis hiccup into an unhandled 'error'. */
    private watch<T extends Worker>(worker: T): T {
        worker.on('error', (error) => this.logger.error(`worker ${worker.name}: ${error.message}`));
        return worker;
    }
}

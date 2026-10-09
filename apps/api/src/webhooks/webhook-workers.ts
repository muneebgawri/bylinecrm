import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue, Worker } from 'bullmq';
import { ENV, type Env } from '../config/env';
import { WebhooksRetention } from './retention.processor';
import {
    WEBHOOK_MAINTENANCE_QUEUE,
    WEBHOOK_QUEUE,
    WEBHOOK_RETENTION_EVERY_MS,
    WEBHOOK_WORKER_CONCURRENCY,
    backoffDelayMs,
} from './webhooks.constants';
import { WebhooksProcessor } from './webhooks.processor';
import type { DeliveryJob } from './webhooks.service';

const RETENTION_JOB = 'retention';

/**
 * Starts the delivery and retention workers when this process is a worker (`WEBHOOK_WORKER`),
 * after the application has booted, and stops them on shutdown. Read from the injected
 * environment at runtime, so a process that only compiles the application (the OpenAPI writer,
 * the router walk) never starts one, and a deployment can run the same image as an API without
 * workers and as a worker. The schedule is idempotent, so several workers share one.
 */
@Injectable()
export class WebhookWorkers implements OnApplicationBootstrap, OnModuleDestroy {
    private readonly logger = new Logger(WebhookWorkers.name);
    private readonly workers: Worker[] = [];

    constructor(
        @Inject(ENV) private readonly env: Env,
        private readonly deliveries: WebhooksProcessor,
        private readonly retention: WebhooksRetention,
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
                    settings: { backoffStrategy: (attemptsMade: number) => backoffDelayMs(attemptsMade) },
                }),
            ),
            this.watch(
                new Worker(WEBHOOK_MAINTENANCE_QUEUE, () => this.retention.prune().then(() => undefined), {
                    connection,
                }),
            ),
        );
        await this.maintenance.upsertJobScheduler(
            RETENTION_JOB,
            { every: WEBHOOK_RETENTION_EVERY_MS },
            { name: RETENTION_JOB },
        );
    }

    async onModuleDestroy(): Promise<void> {
        await Promise.all(this.workers.map((worker) => worker.close()));
    }

    /** A worker without an error listener turns a Redis hiccup into an unhandled 'error'. */
    private watch<T extends Worker>(worker: T): T {
        worker.on('error', (error) => this.logger.error(`worker ${worker.name}: ${error.message}`));
        return worker;
    }
}

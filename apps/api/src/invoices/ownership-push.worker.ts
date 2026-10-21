import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { Worker, type Job } from 'bullmq';
import { ENV, type Env } from '../config/env';
import { OWNERSHIP_PUSH_ATTEMPTS, OWNERSHIP_PUSH_JOB, OWNERSHIP_PUSH_QUEUE } from './invoices.constants';
import { OwnershipPushService, type OwnershipPushJob } from './ownership-push.service';

/**
 * Pushes ownership changes to NewswireOS (PNW-765) in the process that verifies invoices (`INVOICE_WORKER`, the
 * NewswireOS worker). A retryable failure throws, so the queue's backoff tries again; the last attempt settles the
 * delivery as `failed` instead.
 */
@Injectable()
export class OwnershipPushWorker implements OnApplicationBootstrap, OnModuleDestroy {
    private readonly logger = new Logger(OwnershipPushWorker.name);
    private worker: Worker | null = null;

    constructor(
        @Inject(ENV) private readonly env: Env,
        private readonly push: OwnershipPushService,
    ) {}

    onApplicationBootstrap(): void {
        if (!this.env.INVOICE_WORKER) return;
        this.worker = new Worker<OwnershipPushJob>(OWNERSHIP_PUSH_QUEUE, (job) => this.process(job), {
            connection: { url: this.env.REDIS_URL, maxRetriesPerRequest: null },
        });
        this.worker.on('error', (error) => this.logger.error(`worker ${OWNERSHIP_PUSH_QUEUE}: ${error.message}`));
    }

    async onModuleDestroy(): Promise<void> {
        await this.worker?.close();
    }

    private async process(job: Job<OwnershipPushJob>): Promise<void> {
        if (job.name !== OWNERSHIP_PUSH_JOB) return;
        const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? OWNERSHIP_PUSH_ATTEMPTS);
        const outcome = await this.push.deliver(job.data.workspaceId, job.data.deliveryId, { finalAttempt });
        if (outcome === 'retry') throw new Error('NewswireOS did not take the ownership change; retrying');
    }
}

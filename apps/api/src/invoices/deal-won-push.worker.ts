import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { Worker, type Job } from 'bullmq';
import { ENV, type Env } from '../config/env';
import { DealWonPushService, type DealWonPushJob } from './deal-won-push.service';
import {
    DEAL_WON_PUSH_JOB,
    DEAL_WON_PUSH_QUEUE,
    OWNERSHIP_PUSH_ATTEMPTS,
    OWNERSHIP_PUSH_SWEEP_EVERY_MS,
} from './invoices.constants';

/**
 * Pushes won deals to NewswireOS (PNW-766) in the NewswireOS worker (`INVOICE_WORKER`), as the ownership push does: a
 * retryable failure throws, so the queue's backoff tries again; the last attempt settles the delivery as `failed`.
 */
@Injectable()
export class DealWonPushWorker implements OnApplicationBootstrap, OnModuleDestroy {
    private readonly logger = new Logger(DealWonPushWorker.name);
    private worker: Worker | null = null;
    private sweepTimer: NodeJS.Timeout | null = null;

    constructor(
        @Inject(ENV) private readonly env: Env,
        private readonly push: DealWonPushService,
    ) {}

    onApplicationBootstrap(): void {
        if (!this.env.INVOICE_WORKER) return;
        this.worker = new Worker<DealWonPushJob>(DEAL_WON_PUSH_QUEUE, (job) => this.process(job), {
            connection: { url: this.env.REDIS_URL, maxRetriesPerRequest: null },
        });
        this.worker.on('error', (error) => this.logger.error(`worker ${DEAL_WON_PUSH_QUEUE}: ${error.message}`));
        this.sweepTimer = setInterval(() => void this.sweepOnce(), OWNERSHIP_PUSH_SWEEP_EVERY_MS);
        this.sweepTimer.unref();
    }

    private async sweepOnce(): Promise<void> {
        try {
            const requeued = await this.push.sweep();
            if (requeued > 0) this.logger.warn(`re-queued ${requeued} stuck deal-won push deliveries`);
        } catch (error) {
            this.logger.error(`deal-won push sweep: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    async onModuleDestroy(): Promise<void> {
        if (this.sweepTimer) clearInterval(this.sweepTimer);
        await this.worker?.close();
    }

    private async process(job: Job<DealWonPushJob>): Promise<void> {
        if (job.name !== DEAL_WON_PUSH_JOB) return;
        const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? OWNERSHIP_PUSH_ATTEMPTS);
        const outcome = await this.push.deliver(job.data.workspaceId, job.data.deliveryId, { finalAttempt });
        if (outcome === 'retry') throw new Error('NewswireOS did not take the won deal; retrying');
    }
}

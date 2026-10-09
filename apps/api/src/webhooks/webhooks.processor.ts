import { Injectable, Logger } from '@nestjs/common';
import { DelayedError, type Job } from 'bullmq';
import { RedisService } from '../infra/redis.service';
import { WEBHOOK_ENDPOINT_RATE } from './webhooks.constants';
import { WebhooksService, type DeliveryJob } from './webhooks.service';

/**
 * Thrown to make the queue retry. It carries the wait the service computed from the row's
 * attempt count, and the queue's backoff strategy uses exactly that — so the queue and the
 * row's `nextAttemptAt` cannot disagree, even for a job the sweep re-enqueued.
 */
export class RetryableDeliveryError extends Error {
    constructor(
        statusCode: number | null,
        readonly retryDelayMs: number,
    ) {
        super(
            `delivery attempt failed${statusCode === null ? '' : ` with HTTP ${statusCode}`}; retrying in ${retryDelayMs} ms`,
        );
        this.name = 'RetryableDeliveryError';
    }
}

/**
 * What the delivery worker does with one job. One job is one delivery; the row decides the attempt
 * number and the wait before the next (the queue only carries out the retry it is told to), so the
 * row and the queue agree. Per endpoint, no more than the rate constant allows is started in a
 * window; a job past it is put back to sleep until the window turns, not failed.
 */
@Injectable()
export class WebhooksProcessor {
    private readonly logger = new Logger(WebhooksProcessor.name);

    constructor(
        private readonly webhooks: WebhooksService,
        private readonly redis: RedisService,
    ) {}

    async process(job: Job<DeliveryJob>, token?: string): Promise<void> {
        const wait = await this.rateLimitWait(job.data.endpointId);
        if (wait > 0) {
            await job.moveToDelayed(Date.now() + wait, token);
            throw new DelayedError();
        }
        const outcome = await this.webhooks.attempt(job.data);
        if (!outcome.ok && !outcome.final) {
            throw new RetryableDeliveryError(outcome.statusCode, outcome.retryDelayMs ?? 0);
        }
        if (!outcome.ok) this.logger.warn(`delivery ${job.data.deliveryId} ended without success`);
    }

    /**
     * A sliding count per endpoint in Redis: the n-th start in a window, or how long until the
     * window turns. The counter is the only per-endpoint state the worker keeps.
     */
    private async rateLimitWait(endpointId: string): Promise<number> {
        if (this.redis.status === 'wait') await this.redis.connect();
        const key = `webhooks:rate:${endpointId}`;
        const count = await this.redis.incr(key);
        if (count === 1) await this.redis.pexpire(key, WEBHOOK_ENDPOINT_RATE.perMs);
        if (count <= WEBHOOK_ENDPOINT_RATE.max) return 0;
        const ttl = await this.redis.pttl(key);
        return ttl > 0 ? ttl : WEBHOOK_ENDPOINT_RATE.perMs;
    }
}

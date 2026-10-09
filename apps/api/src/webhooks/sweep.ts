import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { PrismaService } from '../infra/prisma.service';
import {
    WEBHOOK_QUEUE,
    WEBHOOK_STUCK_DELIVERING_MS,
    WEBHOOK_SWEEP_BATCH,
    WEBHOOK_SWEEP_GRACE_MS,
} from './webhooks.constants';
import { WebhooksService, type DeliveryJob } from './webhooks.service';

/** What one pass did, for the log and the tests. */
export interface SweepResult {
    /** `delivering` rows abandoned past the stuck threshold, returned to `pending`. */
    freed: number;
    /** Rows that had no live job and were put back on the queue. */
    requeued: number;
}

/**
 * Finds deliveries whose job was lost and puts them back on the queue. A delivery row is written
 * before its job is added, so a Redis outage at that moment — or a worker killed mid-attempt —
 * leaves a row nothing will ever pick up. Three shapes, all older than a grace period:
 *
 * - `pending` with no live job (the add failed);
 * - `failed` whose retry time has passed with no live job (the retry was lost);
 * - `delivering` whose attempt began past the stuck threshold (the worker died) — returned to
 *   `pending` with its attempt count unchanged, so the lost attempt still counts.
 *
 * Re-enqueueing goes through `WebhooksService.enqueue`, whose job id is the delivery's: a delivery
 * that does have a live job is never given a second one, and running the sweep twice sends
 * nothing twice. Runs as the owner: it spans every workspace and is not a request.
 */
@Injectable()
export class WebhooksSweep {
    private readonly logger = new Logger(WebhooksSweep.name);

    constructor(
        private readonly ownerPrisma: PrismaService,
        private readonly webhooks: WebhooksService,
        @InjectQueue(WEBHOOK_QUEUE) private readonly queue: Queue<DeliveryJob>,
    ) {}

    async run(now = Date.now()): Promise<SweepResult> {
        const graceCutoff = new Date(now - WEBHOOK_SWEEP_GRACE_MS);
        const stuckCutoff = new Date(now - WEBHOOK_STUCK_DELIVERING_MS);

        const freed = await this.ownerPrisma.webhookDelivery.updateMany({
            where: { status: 'delivering', attemptStartedAt: { lt: stuckCutoff } },
            data: { status: 'pending', nextAttemptAt: null },
        });

        const candidates = await this.ownerPrisma.webhookDelivery.findMany({
            where: {
                OR: [
                    { status: 'pending', createdAt: { lt: graceCutoff } },
                    { status: 'failed', nextAttemptAt: { lt: graceCutoff } },
                ],
            },
            select: { id: true, workspaceId: true, endpointId: true },
            orderBy: { createdAt: 'asc' },
            take: WEBHOOK_SWEEP_BATCH,
        });

        let requeued = 0;
        for (const row of candidates) {
            if (await this.queue.getJob(row.id)) continue;
            await this.webhooks.enqueue({
                deliveryId: row.id,
                workspaceId: row.workspaceId,
                endpointId: row.endpointId,
            });
            requeued += 1;
        }
        if (freed.count + requeued > 0) {
            this.logger.warn(`sweep: freed ${freed.count} stuck deliveries, re-enqueued ${requeued} stranded ones`);
        }
        return { freed: freed.count, requeued };
    }
}

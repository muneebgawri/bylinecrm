import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../infra/prisma.service';
import { WEBHOOK_RETENTION_DAYS } from './webhooks.constants';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Prunes the delivery log on the retention constants: succeeded rows soon, failed and dead rows
 * later. It runs as the owner because it spans every workspace and because the app role has no
 * DELETE on the table — the one place deliveries are ever removed. `WebhookWorkers` schedules it.
 */
@Injectable()
export class WebhooksRetention {
    private readonly logger = new Logger(WebhooksRetention.name);

    constructor(private readonly ownerPrisma: PrismaService) {}

    async prune(now = Date.now()): Promise<{ succeeded: number; failedOrDead: number }> {
        const succeeded = await this.ownerPrisma.webhookDelivery.deleteMany({
            where: {
                status: 'succeeded',
                createdAt: { lt: new Date(now - WEBHOOK_RETENTION_DAYS.succeeded * DAY_MS) },
            },
        });
        const failed = await this.ownerPrisma.webhookDelivery.deleteMany({
            where: {
                status: { in: ['failed', 'dead'] },
                createdAt: { lt: new Date(now - WEBHOOK_RETENTION_DAYS.failedOrDead * DAY_MS) },
            },
        });
        if (succeeded.count + failed.count > 0) {
            this.logger.log(`pruned ${succeeded.count} succeeded and ${failed.count} failed/dead deliveries`);
        }
        return { succeeded: succeeded.count, failedOrDead: failed.count };
    }
}

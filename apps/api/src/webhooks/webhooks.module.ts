import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ENV, type Env } from '../config/env';
import { WebhooksRetention } from './retention.processor';
import { WebhookSender } from './sender';
import { WebhooksSweep } from './sweep';
import { WebhookWorkers } from './webhook-workers';
import { WebhooksController } from './webhooks.controller';
import { WEBHOOK_MAINTENANCE_QUEUE, WEBHOOK_MAX_ATTEMPTS, WEBHOOK_QUEUE } from './webhooks.constants';
import { WebhooksProcessor } from './webhooks.processor';
import { WebhooksService } from './webhooks.service';
import { WebhooksSubscriber } from './webhooks.subscriber';

/**
 * Outbound webhooks (P1-5): the routes, the subscriber that enqueues, and the workers that
 * deliver and prune — started at runtime by `WebhookWorkers` when this process is a worker. The
 * queue's attempts and backoff come from the constants file, so the queue retries exactly as the
 * delivery row says. Queues connect lazily: compiling the application opens no connection.
 */
@Module({
    imports: [
        BullModule.forRootAsync({
            inject: [ENV],
            useFactory: (env: Env) => ({
                connection: { url: env.REDIS_URL, maxRetriesPerRequest: null, lazyConnect: true },
            }),
        }),
        BullModule.registerQueue({
            name: WEBHOOK_QUEUE,
            defaultJobOptions: { attempts: WEBHOOK_MAX_ATTEMPTS, backoff: { type: 'custom' } },
        }),
        BullModule.registerQueue({ name: WEBHOOK_MAINTENANCE_QUEUE }),
    ],
    controllers: [WebhooksController],
    providers: [
        WebhookSender,
        WebhooksService,
        WebhooksSubscriber,
        WebhooksProcessor,
        WebhooksRetention,
        WebhooksSweep,
        WebhookWorkers,
    ],
    exports: [WebhooksService],
})
export class WebhooksModule {}

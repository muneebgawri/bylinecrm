import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue, Worker } from 'bullmq';
import { ENV, type Env } from '../config/env';
import {
    NOTIFICATIONS_MAINTENANCE_QUEUE,
    TASK_DIGEST_CRON,
    TASK_DIGEST_JOB,
    TASK_DUE_EVERY_MS,
    TASK_DUE_JOB,
} from './notifications.constants';
import { TaskNotificationsService } from './task-notifications.service';

/**
 * The repeating notification jobs (#192), in a worker process (`NOTIFICATIONS_WORKER`): due reminders
 * every `TASK_DUE_EVERY_MS`, and the morning digest at `TASK_DIGEST_CRON` (UTC). Both are idempotent,
 * so a job run twice tells nobody twice.
 */
@Injectable()
export class NotificationsWorkers implements OnApplicationBootstrap, OnModuleDestroy {
    private readonly logger = new Logger(NotificationsWorkers.name);
    private worker: Worker | null = null;

    constructor(
        @Inject(ENV) private readonly env: Env,
        private readonly notifications: TaskNotificationsService,
        @InjectQueue(NOTIFICATIONS_MAINTENANCE_QUEUE) private readonly maintenance: Queue,
    ) {}

    async onApplicationBootstrap(): Promise<void> {
        if (!this.env.NOTIFICATIONS_WORKER) return;
        this.worker = new Worker(
            NOTIFICATIONS_MAINTENANCE_QUEUE,
            async (job) => {
                if (job.name === TASK_DUE_JOB) await this.notifications.remindDue();
                else if (job.name === TASK_DIGEST_JOB) await this.notifications.sendDigests();
            },
            { connection: { url: this.env.REDIS_URL, maxRetriesPerRequest: null } },
        );
        this.worker.on('error', (error) =>
            this.logger.error(`worker ${NOTIFICATIONS_MAINTENANCE_QUEUE}: ${error.message}`),
        );
        await this.maintenance.upsertJobScheduler(TASK_DUE_JOB, { every: TASK_DUE_EVERY_MS }, { name: TASK_DUE_JOB });
        await this.maintenance.upsertJobScheduler(
            TASK_DIGEST_JOB,
            { pattern: TASK_DIGEST_CRON, tz: 'UTC' },
            { name: TASK_DIGEST_JOB },
        );
    }

    async onModuleDestroy(): Promise<void> {
        await this.worker?.close();
    }
}

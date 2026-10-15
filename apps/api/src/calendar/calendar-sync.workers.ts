import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { GOOGLE_CALENDAR_SCOPE } from '@bylinecrm/shared';
import { Queue, Worker, type Job } from 'bullmq';
import { ENV, type Env } from '../config/env';
import { PrismaService } from '../infra/prisma.service';
import { CALENDAR_SYNC_EVERY_MS, CALENDAR_SYNC_QUEUE, CALENDAR_SYNC_WORKER_CONCURRENCY } from './calendar.constants';
import { CalendarSyncService } from './calendar-sync.service';

/** A calendar's sync job. Its id is the mailbox's, so one calendar has at most one queued or running job. */
export interface CalendarSyncJob {
    workspaceId: string;
    mailboxId: string;
}

const SYNC_JOB = 'sync';
const TICK_JOB = 'tick';

/**
 * Puts calendar syncs on the queue, and (in a worker process, `CALENDAR_SYNC_WORKER`) runs them. A tick
 * every `CALENDAR_SYNC_EVERY_MS` enqueues every connected personal mailbox whose grant reads the calendar;
 * a mailbox connecting is enqueued at once (the subscriber). Enqueueing is idempotent per mailbox: the
 * job id is the mailbox id. A run that throws is retried by the queue's backoff; the next tick picks up
 * anything else.
 */
@Injectable()
export class CalendarSyncWorkers implements OnApplicationBootstrap, OnModuleDestroy {
    private readonly logger = new Logger(CalendarSyncWorkers.name);
    private worker: Worker | null = null;

    constructor(
        @Inject(ENV) private readonly env: Env,
        private readonly ownerPrisma: PrismaService,
        private readonly sync: CalendarSyncService,
        @InjectQueue(CALENDAR_SYNC_QUEUE) private readonly queue: Queue,
    ) {}

    /** Queues a run for the mailbox's calendar; `false` when one is already queued or running. */
    async enqueue(job: CalendarSyncJob): Promise<boolean> {
        const existing = await this.queue.getJob(job.mailboxId);
        if (existing && !(await existing.isCompleted()) && !(await existing.isFailed())) return false;
        await this.queue.add(SYNC_JOB, job, { jobId: job.mailboxId });
        return true;
    }

    async onApplicationBootstrap(): Promise<void> {
        if (!this.env.CALENDAR_SYNC_WORKER) return;
        this.worker = new Worker(CALENDAR_SYNC_QUEUE, (job) => this.process(job), {
            connection: { url: this.env.REDIS_URL, maxRetriesPerRequest: null },
            concurrency: CALENDAR_SYNC_WORKER_CONCURRENCY,
        });
        this.worker.on('error', (error) => this.logger.error(`worker ${CALENDAR_SYNC_QUEUE}: ${error.message}`));
        await this.queue.upsertJobScheduler(TICK_JOB, { every: CALENDAR_SYNC_EVERY_MS }, { name: TICK_JOB });
    }

    async onModuleDestroy(): Promise<void> {
        await this.worker?.close();
    }

    private async process(job: Job): Promise<unknown> {
        if (job.name === TICK_JOB) return this.tick();
        if (job.name === SYNC_JOB) {
            const { workspaceId, mailboxId } = job.data as CalendarSyncJob;
            return this.sync.syncCalendar(workspaceId, mailboxId);
        }
        this.logger.warn(`calendar-sync job ${job.name} is not one this worker knows`);
        return null;
    }

    /** Every connected personal mailbox that reads its calendar, in every workspace: read as the owner, since a tick is no tenant's. */
    private async tick(): Promise<number> {
        const mailboxes = await this.ownerPrisma.mailbox.findMany({
            where: { status: 'connected', purpose: 'personal', grantedScopes: { has: GOOGLE_CALENDAR_SCOPE } },
            select: { id: true, workspaceId: true },
        });
        let queued = 0;
        for (const m of mailboxes) if (await this.enqueue({ workspaceId: m.workspaceId, mailboxId: m.id })) queued += 1;
        return queued;
    }
}

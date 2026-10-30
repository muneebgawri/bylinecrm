import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue, Worker, type Job } from 'bullmq';
import { ENV, type Env } from '../config/env';
import { PrismaService } from '../infra/prisma.service';
import { DelegationService } from '../mail-accounts/delegation.service';
import { MAIL_SYNC_EVERY_MS, MAIL_SYNC_QUEUE, MAIL_SYNC_WORKER_CONCURRENCY } from './mail-sync.constants';
import { MailSyncService } from './mail-sync.service';
import { queueFailure, rateLimitCooldownUntil, type RateLimitRecord } from './retry';

/** A mailbox's sync job. Its id is the mailbox's, so one mailbox has at most one queued or running job. */
export interface MailSyncJob {
    workspaceId: string;
    mailboxId: string;
}

const SYNC_JOB = 'sync';
const TICK_JOB = 'tick';

/**
 * Puts mailbox syncs on the queue, and (in a worker process, `MAIL_SYNC_WORKER`) runs them. A tick
 * every `MAIL_SYNC_EVERY_MS` enqueues every connected mailbox; a mailbox connecting is enqueued at
 * once (the subscriber). Enqueueing is idempotent per mailbox: the job id is the mailbox id, so a
 * mailbox already queued or running is not queued twice. A run that throws is retried by the
 * queue's backoff (`MAIL_SYNC_JOB_ATTEMPTS`), except one Gmail rate-limited: its cool-down decides
 * (`queueFailure`). The next tick picks up anything else.
 */
@Injectable()
export class MailSyncWorkers implements OnApplicationBootstrap, OnModuleDestroy {
    private readonly logger = new Logger(MailSyncWorkers.name);
    private worker: Worker | null = null;

    constructor(
        @Inject(ENV) private readonly env: Env,
        private readonly ownerPrisma: PrismaService,
        private readonly sync: MailSyncService,
        private readonly delegation: DelegationService,
        @InjectQueue(MAIL_SYNC_QUEUE) private readonly queue: Queue,
    ) {}

    /** Queues a run for the mailbox; `false` when one is already queued or running. */
    async enqueue(job: MailSyncJob): Promise<boolean> {
        const existing = await this.queue.getJob(job.mailboxId);
        if (existing && !(await existing.isCompleted()) && !(await existing.isFailed())) return false;
        await this.queue.add(SYNC_JOB, job, { jobId: job.mailboxId });
        return true;
    }

    async onApplicationBootstrap(): Promise<void> {
        if (!this.env.MAIL_SYNC_WORKER) return;
        this.worker = new Worker(MAIL_SYNC_QUEUE, (job) => this.process(job), {
            connection: { url: this.env.REDIS_URL, maxRetriesPerRequest: null },
            concurrency: MAIL_SYNC_WORKER_CONCURRENCY,
        });
        this.worker.on('error', (error) => this.logger.error(`worker ${MAIL_SYNC_QUEUE}: ${error.message}`));
        await this.queue.upsertJobScheduler(TICK_JOB, { every: MAIL_SYNC_EVERY_MS }, { name: TICK_JOB });
    }

    async onModuleDestroy(): Promise<void> {
        await this.worker?.close();
    }

    private async process(job: Job): Promise<unknown> {
        if (job.name === TICK_JOB) return this.tick();
        if (job.name === SYNC_JOB) {
            const { workspaceId, mailboxId } = job.data as MailSyncJob;
            try {
                return await this.sync.syncMailbox(workspaceId, mailboxId);
            } catch (error) {
                throw queueFailure(error);
            }
        }
        this.logger.warn(`mail-sync job ${job.name} is not one this worker knows`);
        return null;
    }

    /** Every connected mailbox, in every workspace: read as the owner, since a tick is no tenant's. */
    private async tick(): Promise<number> {
        // #225: delegated mailboxes follow the members and settings first, so this tick syncs the right set.
        try {
            await this.delegation.reconcileAll();
        } catch (error) {
            this.logger.error(`delegation reconcile failed: ${String(error)}`);
        }
        const mailboxes = await this.ownerPrisma.mailbox.findMany({
            // An SMTP2Go mailbox (TRANS-1) has no Gmail to read: its replies arrive in its Reply-To mailbox.
            where: { status: 'connected', transport: 'gmail' },
            select: { id: true, workspaceId: true, syncState: { select: { lastError: true } } },
        });
        let queued = 0;
        const now = Date.now();
        for (const m of mailboxes) {
            // A mailbox whose last run ended rate-limited waits out its cool-down: asking Gmail again every tick kept
            // the per-user limit tripped for days (the service inboxes, from 2026-10-25).
            if (rateLimitCooldownUntil((m.syncState?.lastError ?? null) as RateLimitRecord | null) > now) continue;
            if (await this.enqueue({ workspaceId: m.workspaceId, mailboxId: m.id })) queued += 1;
        }
        return queued;
    }
}

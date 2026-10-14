import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { TWENTY_SYNC_INTERVAL_MS, type TwentySyncEvery, type TwentySyncInterval } from '@bylinecrm/shared';
import { Queue, Worker, type Job } from 'bullmq';
import { ENV, type Env } from '../config/env';
import { PrismaService } from '../infra/prisma.service';
import { TwentyImportRunner } from './import-runner';
import {
    TWENTY_IMPORT_JOB_ATTEMPTS,
    TWENTY_IMPORT_LOCK_MS,
    TWENTY_IMPORT_QUEUE,
    TWENTY_SYNC_JOB,
    twentySyncSchedulerId,
} from './twenty-import.constants';
import { TwentySyncService } from './twenty-sync.service';

/** A run's job. Its id is the run's, so one run has at most one queued or running job. */
export interface TwentyImportJob {
    workspaceId: string;
    runId: string;
}

/** The schedule's job (#185): the workspace whose sync is due; the tick decides whether a run starts. */
export interface TwentySyncJob {
    workspaceId: string;
}

const RUN_JOB = 'run';

/**
 * Puts import runs on the queue, and (in a worker process, `TWENTY_IMPORT_WORKER`) drives them.
 * The run row is the truth (`TwentyImportRunner`): a job that throws is retried by the queue from
 * the run's cursor; one that fails for good marks the run failed; a run left queued or running
 * when a process died is given its job again at the next start.
 *
 * The automatic sync (#185) is a BullMQ job scheduler per workspace on the same queue — one, keyed
 * by the workspace, replaced when the interval changes and removed when syncing is off — whose
 * job is a tick: `TwentySyncService` starts a `changes` run when one is due. The settings row is
 * the truth; a worker's start puts the schedulers in line with it, so a lost Redis loses nothing.
 */
@Injectable()
export class TwentyImportWorkers implements OnApplicationBootstrap, OnModuleDestroy {
    private readonly logger = new Logger(TwentyImportWorkers.name);
    private worker: Worker | null = null;

    constructor(
        @Inject(ENV) private readonly env: Env,
        private readonly ownerPrisma: PrismaService,
        private readonly runner: TwentyImportRunner,
        private readonly sync: TwentySyncService,
        @InjectQueue(TWENTY_IMPORT_QUEUE) private readonly queue: Queue<TwentyImportJob | TwentySyncJob>,
    ) {}

    /** Queues the run; `false` when its job is already queued or running. Never throws: Redis down is logged. */
    async enqueue(job: TwentyImportJob): Promise<boolean> {
        try {
            const existing = await this.queue.getJob(job.runId);
            if (existing && !(await existing.isCompleted()) && !(await existing.isFailed())) return false;
            await this.queue.add(RUN_JOB, job, { jobId: job.runId });
            return true;
        } catch (error) {
            this.logger.error(`could not queue import run ${job.runId}: ${describe(error)}`);
            return false;
        }
    }

    /**
     * Puts the workspace's schedule where its setting says (#185): a scheduler at the interval, or
     * none. Never throws: Redis down is logged, and the next worker start puts it right.
     */
    async schedule(workspaceId: string, interval: TwentySyncInterval): Promise<void> {
        const id = twentySyncSchedulerId(workspaceId);
        try {
            if (interval === 'off') {
                await this.queue.removeJobScheduler(id);
                return;
            }
            await this.queue.upsertJobScheduler(
                id,
                { every: TWENTY_SYNC_INTERVAL_MS[interval as TwentySyncEvery] },
                { name: TWENTY_SYNC_JOB, data: { workspaceId } },
            );
        } catch (error) {
            this.logger.error(`could not schedule twenty sync for ${workspaceId} (${interval}): ${describe(error)}`);
        }
    }

    /** When the workspace's schedule next fires, or null while it has none (or Redis cannot say). */
    async nextSyncAt(workspaceId: string): Promise<Date | null> {
        try {
            const scheduler = await this.queue.getJobScheduler(twentySyncSchedulerId(workspaceId));
            return scheduler?.next ? new Date(scheduler.next) : null;
        } catch (error) {
            this.logger.error(`could not read the twenty sync schedule of ${workspaceId}: ${describe(error)}`);
            return null;
        }
    }

    /** The schedule fired: the run it started and queued, or null when nothing was due. */
    async tick(workspaceId: string): Promise<string | null> {
        const runId = await this.sync.tick(workspaceId);
        if (runId) await this.enqueue({ workspaceId, runId });
        return runId;
    }

    async onApplicationBootstrap(): Promise<void> {
        if (!this.env.TWENTY_IMPORT_WORKER) return;
        this.worker = new Worker<TwentyImportJob | TwentySyncJob>(TWENTY_IMPORT_QUEUE, (job) => this.process(job), {
            connection: { url: this.env.REDIS_URL, maxRetriesPerRequest: null },
            concurrency: 1,
            lockDuration: TWENTY_IMPORT_LOCK_MS,
        });
        this.worker.on('error', (error) => this.logger.error(`worker ${TWENTY_IMPORT_QUEUE}: ${error.message}`));
        this.worker.on('failed', (job, error) => {
            if (!job || job.name !== RUN_JOB || job.attemptsMade < TWENTY_IMPORT_JOB_ATTEMPTS) return;
            void this.runner.abandon((job.data as TwentyImportJob).runId, error.message);
        });
        await this.resume();
        await this.reconcileSchedules();
    }

    async onModuleDestroy(): Promise<void> {
        await this.worker?.close();
    }

    private async process(job: Job<TwentyImportJob | TwentySyncJob>): Promise<void> {
        if (job.name === RUN_JOB) {
            await this.runner.run((job.data as TwentyImportJob).runId);
            return;
        }
        if (job.name === TWENTY_SYNC_JOB) {
            await this.tick(job.data.workspaceId);
            return;
        }
        this.logger.warn(`twenty-import job ${job.name} is not one this worker knows`);
    }

    /**
     * The schedulers follow the settings rows (#185): every workspace syncing has one at its interval,
     * and no scheduler outlives its setting. Never throws: Redis down is logged.
     */
    private async reconcileSchedules(): Promise<void> {
        try {
            const syncing = await this.ownerPrisma.twentyImportSettings.findMany({
                where: { syncInterval: { not: 'off' } },
                select: { workspaceId: true, syncInterval: true },
            });
            const wanted = new Map(syncing.map((row) => [twentySyncSchedulerId(row.workspaceId), row]));
            for (const scheduler of await this.queue.getJobSchedulers(0, -1)) {
                if (scheduler.key.startsWith(twentySyncSchedulerId('')) && !wanted.has(scheduler.key)) {
                    await this.queue.removeJobScheduler(scheduler.key);
                }
            }
            for (const row of wanted.values()) {
                await this.schedule(row.workspaceId, row.syncInterval as TwentySyncInterval);
            }
        } catch (error) {
            this.logger.error(`could not reconcile twenty sync schedules: ${describe(error)}`);
        }
    }

    /** Runs a dead process left behind get their job back; the runner continues from the cursor. */
    private async resume(): Promise<void> {
        const open = await this.ownerPrisma.twentyImportRun.findMany({
            where: { status: { in: ['queued', 'running'] } },
            select: { id: true, workspaceId: true },
        });
        for (const run of open) await this.enqueue({ workspaceId: run.workspaceId, runId: run.id });
    }
}

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

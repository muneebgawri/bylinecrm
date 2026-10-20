import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { TWENTY_SYNC_INTERVAL_MS, type TwentySyncEvery, type TwentySyncInterval } from '@bylinecrm/shared';
import { Prisma } from '@prisma/client';
import { Queue, Worker, type Job } from 'bullmq';
import { ENV, type Env } from '../config/env';
import { PrismaService } from '../infra/prisma.service';
import {
    BIGIN_IMPORT_JOB_ATTEMPTS,
    BIGIN_IMPORT_LOCK_MS,
    BIGIN_IMPORT_QUEUE,
    BIGIN_STAGE_APPLY_JOB,
    BIGIN_SYNC_JOB,
    biginStageApplyJobId,
    biginSyncSchedulerId,
} from './bigin-import.constants';
import { BiginSyncService } from './bigin-sync.service';
import { BiginImportRunner } from './import-runner';
import { BiginStageApplier } from './stage-apply';

export interface BiginImportJob {
    workspaceId: string;
    runId: string;
}

export interface BiginSyncJob {
    workspaceId: string;
}

const RUN_JOB = 'run';

/**
 * Puts Bigin import runs on their queue and, in a worker process (`TWENTY_IMPORT_WORKER`, the importers'
 * one flag), drives them — the Twenty importer's workers (P4-4, #185) for Bigin: a run's job id is the
 * run's, a job that throws is retried from the run's cursor, a run a dead process left is given its job
 * again at the next start; the automatic sync is one job scheduler per workspace whose job is a tick,
 * and a worker's start puts the schedulers in line with the settings rows.
 */
@Injectable()
export class BiginImportWorkers implements OnApplicationBootstrap, OnModuleDestroy {
    private readonly logger = new Logger(BiginImportWorkers.name);
    private worker: Worker | null = null;
    /** Picks up open runs that lost their job (a deploy stopped the worker holding it). */
    private sweep: NodeJS.Timeout | null = null;

    constructor(
        @Inject(ENV) private readonly env: Env,
        private readonly ownerPrisma: PrismaService,
        private readonly runner: BiginImportRunner,
        private readonly sync: BiginSyncService,
        private readonly stageApplier: BiginStageApplier,
        @InjectQueue(BIGIN_IMPORT_QUEUE) private readonly queue: Queue<BiginImportJob | BiginSyncJob>,
    ) {}

    async enqueue(job: BiginImportJob): Promise<boolean> {
        try {
            const existing = await this.queue.getJob(job.runId);
            if (existing && !(await existing.isCompleted()) && !(await existing.isFailed())) return false;
            // A finished job keeps its id: BullMQ ignores an add under it, so it goes first.
            if (existing) await existing.remove();
            await this.queue.add(RUN_JOB, job, { jobId: job.runId });
            return true;
        } catch (error) {
            this.logger.error(`could not queue bigin import run ${job.runId}: ${describe(error)}`);
            return false;
        }
    }

    /** Queues applying the stage mapping to imported deals; one at a time per workspace. */
    async enqueueStageApply(workspaceId: string): Promise<boolean> {
        const jobId = biginStageApplyJobId(workspaceId);
        try {
            const existing = await this.queue.getJob(jobId);
            if (existing && !(await existing.isCompleted()) && !(await existing.isFailed())) return false;
            if (existing) await existing.remove();
            await this.queue.add(BIGIN_STAGE_APPLY_JOB, { workspaceId }, { jobId });
            return true;
        } catch (error) {
            this.logger.error(`could not queue the bigin stage apply of ${workspaceId}: ${describe(error)}`);
            return false;
        }
    }

    async schedule(workspaceId: string, interval: TwentySyncInterval): Promise<void> {
        const id = biginSyncSchedulerId(workspaceId);
        try {
            if (interval === 'off') {
                await this.queue.removeJobScheduler(id);
                return;
            }
            await this.queue.upsertJobScheduler(
                id,
                { every: TWENTY_SYNC_INTERVAL_MS[interval as TwentySyncEvery] },
                { name: BIGIN_SYNC_JOB, data: { workspaceId } },
            );
        } catch (error) {
            this.logger.error(`could not schedule bigin sync for ${workspaceId} (${interval}): ${describe(error)}`);
        }
    }

    async nextSyncAt(workspaceId: string): Promise<Date | null> {
        try {
            const scheduler = await this.queue.getJobScheduler(biginSyncSchedulerId(workspaceId));
            return scheduler?.next ? new Date(scheduler.next) : null;
        } catch (error) {
            this.logger.error(`could not read the bigin sync schedule of ${workspaceId}: ${describe(error)}`);
            return null;
        }
    }

    async tick(workspaceId: string): Promise<string | null> {
        const runId = await this.sync.tick(workspaceId);
        if (runId) await this.enqueue({ workspaceId, runId });
        return runId;
    }

    async onApplicationBootstrap(): Promise<void> {
        if (!this.env.TWENTY_IMPORT_WORKER) return;
        this.worker = new Worker<BiginImportJob | BiginSyncJob>(BIGIN_IMPORT_QUEUE, (job) => this.process(job), {
            connection: { url: this.env.REDIS_URL, maxRetriesPerRequest: null },
            concurrency: 1,
            lockDuration: BIGIN_IMPORT_LOCK_MS,
        });
        this.worker.on('error', (error) => this.logger.error(`worker ${BIGIN_IMPORT_QUEUE}: ${error.message}`));
        this.worker.on('failed', (job, error) => {
            if (!job || job.name !== RUN_JOB || job.attemptsMade < BIGIN_IMPORT_JOB_ATTEMPTS) return;
            // Counted and logged when it fails, never an unhandled rejection; `resume()` at boot retries it.
            this.runner
                .abandon((job.data as BiginImportJob).runId, error.message)
                .catch((e: unknown) =>
                    this.logger.error(
                        `could not mark run ${(job.data as BiginImportJob).runId} failed: ${e instanceof Error ? e.message : String(e)}`,
                    ),
                );
        });
        await this.resume();
        await this.reconcileSchedules();
        // At boot the colour being drained may still hold a run's job, so `resume()` passes over it; once that
        // colour stops, nothing would pick the run up again. Looking again every lock period does.
        this.sweep = setInterval(() => void this.resume(), BIGIN_IMPORT_LOCK_MS);
        this.sweep.unref();
    }

    async onModuleDestroy(): Promise<void> {
        if (this.sweep) clearInterval(this.sweep);
        await this.worker?.close();
    }

    private async process(job: Job<BiginImportJob | BiginSyncJob>): Promise<void> {
        if (job.name === RUN_JOB) {
            await this.runner.run((job.data as BiginImportJob).runId);
            return;
        }
        if (job.name === BIGIN_STAGE_APPLY_JOB) {
            await this.stageApplier.apply(job.data.workspaceId);
            return;
        }
        if (job.name === BIGIN_SYNC_JOB) {
            await this.tick(job.data.workspaceId);
            return;
        }
        this.logger.warn(`bigin-import job ${job.name} is not one this worker knows`);
    }

    private async reconcileSchedules(): Promise<void> {
        try {
            const syncing = await this.ownerPrisma.biginImportSettings.findMany({
                where: { syncInterval: { not: 'off' } },
                select: { workspaceId: true, syncInterval: true },
            });
            const wanted = new Map(syncing.map((row) => [biginSyncSchedulerId(row.workspaceId), row]));
            for (const scheduler of await this.queue.getJobSchedulers(0, -1)) {
                if (scheduler.key.startsWith(biginSyncSchedulerId('')) && !wanted.has(scheduler.key)) {
                    await this.queue.removeJobScheduler(scheduler.key);
                }
            }
            for (const row of wanted.values()) {
                await this.schedule(row.workspaceId, row.syncInterval as TwentySyncInterval);
            }
        } catch (error) {
            this.logger.error(`could not reconcile bigin sync schedules: ${describe(error)}`);
        }
    }

    private async resume(): Promise<void> {
        try {
            const open = await this.ownerPrisma.biginImportRun.findMany({
                where: { status: { in: ['queued', 'running'] } },
                select: { id: true, workspaceId: true },
            });
            for (const run of open) await this.enqueue({ workspaceId: run.workspaceId, runId: run.id });
            // A stage apply a stopped worker left: it is started again (moving a deal twice is a no-op).
            const applies = await this.ownerPrisma.biginImportSettings.findMany({
                where: { stageApply: { not: Prisma.AnyNull } },
                select: { workspaceId: true, stageApply: true },
            });
            for (const row of applies) {
                const status = (row.stageApply as { status?: unknown } | null)?.status;
                if (status === 'queued' || status === 'running') await this.enqueueStageApply(row.workspaceId);
            }
        } catch (error) {
            this.logger.error(`could not resume bigin import runs: ${describe(error)}`);
        }
    }
}

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

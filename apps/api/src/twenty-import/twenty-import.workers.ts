import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue, Worker, type Job } from 'bullmq';
import { ENV, type Env } from '../config/env';
import { PrismaService } from '../infra/prisma.service';
import { TwentyImportRunner } from './import-runner';
import { TWENTY_IMPORT_JOB_ATTEMPTS, TWENTY_IMPORT_LOCK_MS, TWENTY_IMPORT_QUEUE } from './twenty-import.constants';

/** A run's job. Its id is the run's, so one run has at most one queued or running job. */
export interface TwentyImportJob {
    workspaceId: string;
    runId: string;
}

const RUN_JOB = 'run';

/**
 * Puts import runs on the queue, and (in a worker process, `TWENTY_IMPORT_WORKER`) drives them.
 * The run row is the truth (`TwentyImportRunner`): a job that throws is retried by the queue from
 * the run's cursor; one that fails for good marks the run failed; a run left queued or running
 * when a process died is given its job again at the next start.
 */
@Injectable()
export class TwentyImportWorkers implements OnApplicationBootstrap, OnModuleDestroy {
    private readonly logger = new Logger(TwentyImportWorkers.name);
    private worker: Worker | null = null;

    constructor(
        @Inject(ENV) private readonly env: Env,
        private readonly ownerPrisma: PrismaService,
        private readonly runner: TwentyImportRunner,
        @InjectQueue(TWENTY_IMPORT_QUEUE) private readonly queue: Queue<TwentyImportJob>,
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

    async onApplicationBootstrap(): Promise<void> {
        if (!this.env.TWENTY_IMPORT_WORKER) return;
        this.worker = new Worker<TwentyImportJob>(TWENTY_IMPORT_QUEUE, (job) => this.process(job), {
            connection: { url: this.env.REDIS_URL, maxRetriesPerRequest: null },
            concurrency: 1,
            lockDuration: TWENTY_IMPORT_LOCK_MS,
        });
        this.worker.on('error', (error) => this.logger.error(`worker ${TWENTY_IMPORT_QUEUE}: ${error.message}`));
        this.worker.on('failed', (job, error) => {
            if (!job || job.attemptsMade < TWENTY_IMPORT_JOB_ATTEMPTS) return;
            void this.runner.abandon(job.data.runId, error.message);
        });
        await this.resume();
    }

    async onModuleDestroy(): Promise<void> {
        await this.worker?.close();
    }

    private async process(job: Job<TwentyImportJob>): Promise<void> {
        if (job.name !== RUN_JOB) {
            this.logger.warn(`twenty-import job ${job.name} is not one this worker knows`);
            return;
        }
        await this.runner.run(job.data.runId);
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

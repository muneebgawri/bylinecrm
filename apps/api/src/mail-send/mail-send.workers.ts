import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { DelayedError, Queue, Worker, type Job } from 'bullmq';
import { ENV, type Env } from '../config/env';
import { GmailApiError } from '../mail-sync/gmail.port';
import {
    MAIL_SEND_JOB_ATTEMPTS,
    MAIL_SEND_MAINTENANCE_QUEUE,
    MAIL_SEND_QUEUE,
    MAIL_SEND_SWEEP_EVERY_MS,
    MAIL_SEND_WORKER_CONCURRENCY,
} from './mail-send.constants';
import { MailSendService, SendNotDue } from './mail-send.service';
import { MailSendSweep } from './sweep';

/** A send's job. Its id is the message's, so one message has at most one queued or running job. */
export interface MailSendJob {
    workspaceId: string;
    messageId: string;
}

/** The maintenance queue's one repeating job. */
const SWEEP_JOB = 'sweep';

/**
 * Runs sends (in a worker process, `MAIL_SEND_WORKER`): queued ones at once, scheduled ones when
 * their delayed job comes due (P2-5). A delivery that throws — every Gmail request failed
 * transiently — is retried by the queue's backoff (`MAIL_SEND_JOB_ATTEMPTS`); when the last attempt
 * fails too, the message is marked failed. A scheduled send's job that fires before the row's
 * `sendAt` (the send was moved later) goes back to wait, without counting as an attempt. The sweep
 * repeats on the maintenance queue and runs once at start.
 */
@Injectable()
export class MailSendWorkers implements OnApplicationBootstrap, OnModuleDestroy {
    private readonly logger = new Logger(MailSendWorkers.name);
    private readonly workers: Worker[] = [];

    constructor(
        @Inject(ENV) private readonly env: Env,
        private readonly send: MailSendService,
        private readonly sweep: MailSendSweep,
        @InjectQueue(MAIL_SEND_MAINTENANCE_QUEUE) private readonly maintenance: Queue,
    ) {}

    async onApplicationBootstrap(): Promise<void> {
        if (!this.env.MAIL_SEND_WORKER) return;
        const connection = { url: this.env.REDIS_URL, maxRetriesPerRequest: null };
        const sends = this.watch(
            new Worker(MAIL_SEND_QUEUE, (job, token) => this.process(job, token), {
                connection,
                concurrency: MAIL_SEND_WORKER_CONCURRENCY,
            }),
        );
        sends.on('failed', (job, error) => {
            if (!job || job.attemptsMade < (job.opts.attempts ?? MAIL_SEND_JOB_ATTEMPTS)) return;
            const { workspaceId, messageId } = job.data as MailSendJob;
            const code = error instanceof GmailApiError ? `gmail.${error.reason}` : 'internal';
            this.send
                .markExhausted(workspaceId, messageId, code)
                .catch((e: unknown) =>
                    this.logger.error(
                        `send ${messageId}: could not be marked failed: ${e instanceof Error ? e.message : String(e)}`,
                    ),
                );
        });
        this.workers.push(
            sends,
            this.watch(new Worker(MAIL_SEND_MAINTENANCE_QUEUE, (job) => this.maintain(job.name), { connection })),
        );
        await this.maintenance.upsertJobScheduler(SWEEP_JOB, { every: MAIL_SEND_SWEEP_EVERY_MS }, { name: SWEEP_JOB });
        // Once now, so sends stranded while no worker ran are picked up at start, not on the next tick.
        await this.sweep.run().catch((error: unknown) => {
            this.logger.error(`startup send sweep failed: ${error instanceof Error ? error.message : String(error)}`);
        });
    }

    async onModuleDestroy(): Promise<void> {
        await Promise.all(this.workers.map((worker) => worker.close()));
    }

    private async process(job: Job, token?: string): Promise<unknown> {
        const { workspaceId, messageId } = job.data as MailSendJob;
        try {
            return await this.send.deliver(workspaceId, messageId);
        } catch (error) {
            if (!(error instanceof SendNotDue)) throw error;
            await job.moveToDelayed(Date.now() + error.dueInMs, token);
            throw new DelayedError();
        }
    }

    private async maintain(name: string): Promise<void> {
        if (name === SWEEP_JOB) await this.sweep.run();
        else this.logger.warn(`maintenance job ${name} is not one this worker knows`);
    }

    /** A worker without an error listener turns a Redis hiccup into an unhandled 'error'. */
    private watch<T extends Worker>(worker: T): T {
        worker.on('error', (error) => this.logger.error(`worker ${worker.name}: ${error.message}`));
        return worker;
    }
}

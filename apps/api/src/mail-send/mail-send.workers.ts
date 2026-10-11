import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { Worker, type Job } from 'bullmq';
import { ENV, type Env } from '../config/env';
import { GmailApiError } from '../mail-sync/gmail.port';
import { MAIL_SEND_JOB_ATTEMPTS, MAIL_SEND_QUEUE, MAIL_SEND_WORKER_CONCURRENCY } from './mail-send.constants';
import { MailSendService } from './mail-send.service';

/** A send's job. Its id is the message's, so one message has at most one queued or running job. */
export interface MailSendJob {
    workspaceId: string;
    messageId: string;
}

/**
 * Runs queued sends (in a worker process, `MAIL_SEND_WORKER`). A delivery that throws — every Gmail
 * request failed transiently — is retried by the queue's backoff (`MAIL_SEND_JOB_ATTEMPTS`); when
 * the last attempt fails too, the message is marked failed.
 */
@Injectable()
export class MailSendWorkers implements OnApplicationBootstrap, OnModuleDestroy {
    private readonly logger = new Logger(MailSendWorkers.name);
    private worker: Worker | null = null;

    constructor(
        @Inject(ENV) private readonly env: Env,
        private readonly send: MailSendService,
    ) {}

    onApplicationBootstrap(): void {
        if (!this.env.MAIL_SEND_WORKER) return;
        this.worker = new Worker(MAIL_SEND_QUEUE, (job) => this.process(job), {
            connection: { url: this.env.REDIS_URL, maxRetriesPerRequest: null },
            concurrency: MAIL_SEND_WORKER_CONCURRENCY,
        });
        this.worker.on('error', (error) => this.logger.error(`worker ${MAIL_SEND_QUEUE}: ${error.message}`));
        this.worker.on('failed', (job, error) => {
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
    }

    async onModuleDestroy(): Promise<void> {
        await this.worker?.close();
    }

    private process(job: Job): Promise<unknown> {
        const { workspaceId, messageId } = job.data as MailSendJob;
        return this.send.deliver(workspaceId, messageId);
    }
}

import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { UnrecoverableError, Worker, type Job } from 'bullmq';
import { ENV, type Env } from '../config/env';
import {
    TRANSACTIONAL_MAIL_JOB_ATTEMPTS,
    TRANSACTIONAL_MAIL_QUEUE,
    TRANSACTIONAL_MAIL_WORKER_CONCURRENCY,
} from './transactional-mail.constants';
import { TransactionalMailer, type TransactionalMailJob } from './transactional-mailer';
import { PermanentMailError } from './transport.port';

/**
 * Delivers queued transactional mail (in a worker process, `TRANSACTIONAL_MAIL_WORKER`). A
 * transient failure is retried by the queue's backoff; a refusal a retry cannot fix fails the job
 * at once. Either way the log names the job (kind and key), never the recipient's link.
 */
@Injectable()
export class TransactionalMailWorkers implements OnApplicationBootstrap, OnModuleDestroy {
    private readonly logger = new Logger(TransactionalMailWorkers.name);
    private worker?: Worker<TransactionalMailJob>;

    constructor(
        @Inject(ENV) private readonly env: Env,
        private readonly mailer: TransactionalMailer,
    ) {}

    onApplicationBootstrap(): void {
        if (!this.env.TRANSACTIONAL_MAIL_WORKER) return;
        const worker = new Worker<TransactionalMailJob>(TRANSACTIONAL_MAIL_QUEUE, (job) => this.process(job), {
            connection: { url: this.env.REDIS_URL, maxRetriesPerRequest: null },
            concurrency: TRANSACTIONAL_MAIL_WORKER_CONCURRENCY,
        });
        worker.on('error', (error) => this.logger.error(`worker ${worker.name}: ${error.message}`));
        worker.on('failed', (job, error) => {
            if (!job) return;
            const final =
                error instanceof UnrecoverableError ||
                job.attemptsMade >= (job.opts.attempts ?? TRANSACTIONAL_MAIL_JOB_ATTEMPTS);
            if (final) this.logger.error(`${job.name} mail ${job.id ?? '?'} was not delivered: ${error.message}`);
        });
        this.worker = worker;
    }

    async onModuleDestroy(): Promise<void> {
        await this.worker?.close();
    }

    private async process(job: Job<TransactionalMailJob>): Promise<{ id: string }> {
        try {
            return await this.mailer.deliver(job.data);
        } catch (error) {
            if (error instanceof PermanentMailError) throw new UnrecoverableError(error.message);
            throw error;
        }
    }
}

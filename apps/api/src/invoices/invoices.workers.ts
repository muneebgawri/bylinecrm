import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { Worker, type Job } from 'bullmq';
import { ENV, type Env } from '../config/env';
import type { InvoiceVerifyJob } from './invoice-queue';
import { INVOICE_VERIFY_ATTEMPTS, INVOICE_VERIFY_JOB, INVOICE_VERIFY_QUEUE } from './invoices.constants';
import { InvoicesService } from './invoices.service';

/**
 * Verifies invoices against NewswireOS (INV-1) in a worker process (`INVOICE_WORKER`). A NewswireOS that does not
 * answer is retried by the queue's backoff; the last attempt settles the invoice as `needs_review`.
 */
@Injectable()
export class InvoicesWorkers implements OnApplicationBootstrap, OnModuleDestroy {
    private readonly logger = new Logger(InvoicesWorkers.name);
    private worker: Worker | null = null;

    constructor(
        @Inject(ENV) private readonly env: Env,
        private readonly invoices: InvoicesService,
    ) {}

    onApplicationBootstrap(): void {
        if (!this.env.INVOICE_WORKER) return;
        this.worker = new Worker<InvoiceVerifyJob>(INVOICE_VERIFY_QUEUE, (job) => this.process(job), {
            connection: { url: this.env.REDIS_URL, maxRetriesPerRequest: null },
        });
        this.worker.on('error', (error) => this.logger.error(`worker ${INVOICE_VERIFY_QUEUE}: ${error.message}`));
    }

    async onModuleDestroy(): Promise<void> {
        await this.worker?.close();
    }

    private async process(job: Job<InvoiceVerifyJob>): Promise<void> {
        if (job.name !== INVOICE_VERIFY_JOB) return;
        const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? INVOICE_VERIFY_ATTEMPTS);
        await this.invoices.runVerification(job.data.workspaceId, job.data.invoiceId, { finalAttempt });
    }
}

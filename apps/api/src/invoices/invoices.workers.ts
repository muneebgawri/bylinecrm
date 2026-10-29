import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { Queue, Worker, type Job } from 'bullmq';
import { ENV, type Env } from '../config/env';
import { PrismaService } from '../infra/prisma.service';
import { InvoiceQueue, type InvoiceVerifyJob } from './invoice-queue';
import {
    INVOICE_STUCK_AFTER_MS,
    INVOICE_SWEEP_BATCH,
    INVOICE_SWEEP_EVERY_MS,
    INVOICE_SWEEP_JOB,
    INVOICE_VERIFY_ATTEMPTS,
    INVOICE_VERIFY_JOB,
    INVOICE_VERIFY_QUEUE,
} from './invoices.constants';
import { InvoicesService } from './invoices.service';

/**
 * Verifies invoices against NewswireOS (INV-1) in a worker process (`INVOICE_WORKER`). A NewswireOS that does not
 * answer is retried by the queue's backoff; the last attempt settles the invoice as `needs_review`. A sweep beside
 * it (INV-2) re-queues an invoice left `verifying` because its job was lost, so none waits for a person to notice.
 */
@Injectable()
export class InvoicesWorkers implements OnApplicationBootstrap, OnModuleDestroy {
    private readonly logger = new Logger(InvoicesWorkers.name);
    private worker: Worker | null = null;

    constructor(
        @Inject(ENV) private readonly env: Env,
        private readonly invoices: InvoicesService,
        private readonly verifications: InvoiceQueue,
        private readonly ownerPrisma: PrismaService,
        @InjectQueue(INVOICE_VERIFY_QUEUE) private readonly queue: Queue,
    ) {}

    async onApplicationBootstrap(): Promise<void> {
        if (!this.env.INVOICE_WORKER) return;
        this.worker = new Worker<InvoiceVerifyJob>(INVOICE_VERIFY_QUEUE, (job) => this.process(job), {
            connection: { url: this.env.REDIS_URL, maxRetriesPerRequest: null },
        });
        this.worker.on('error', (error) => this.logger.error(`worker ${INVOICE_VERIFY_QUEUE}: ${error.message}`));
        await this.queue.upsertJobScheduler(
            INVOICE_SWEEP_JOB,
            { every: INVOICE_SWEEP_EVERY_MS },
            { name: INVOICE_SWEEP_JOB },
        );
    }

    /**
     * Re-queues invoices still `verifying` long after they were entered, oldest first, a batch at a time. Across
     * workspaces (the owner client, as every sweep reads), by the partial index on `verifying` rows. Queuing one
     * that still has a live job is a no-op (`InvoiceQueue` keys jobs on the invoice), so the sweep never doubles one.
     */
    async sweep(now = new Date()): Promise<number> {
        const stuck = await this.ownerPrisma.dealInvoice.findMany({
            where: { status: 'verifying', updatedAt: { lt: new Date(now.getTime() - INVOICE_STUCK_AFTER_MS) } },
            orderBy: { updatedAt: 'asc' },
            take: INVOICE_SWEEP_BATCH,
            select: { id: true, workspaceId: true },
        });
        for (const invoice of stuck) {
            await this.verifications.enqueue({ workspaceId: invoice.workspaceId, invoiceId: invoice.id });
        }
        if (stuck.length > 0) this.logger.warn(`re-queued ${stuck.length} invoice(s) left verifying`);
        return stuck.length;
    }

    async onModuleDestroy(): Promise<void> {
        await this.worker?.close();
    }

    private async process(job: Job<InvoiceVerifyJob>): Promise<void> {
        if (job.name === INVOICE_SWEEP_JOB) {
            await this.sweep();
            return;
        }
        if (job.name !== INVOICE_VERIFY_JOB) return;
        const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? INVOICE_VERIFY_ATTEMPTS);
        await this.invoices.runVerification(job.data.workspaceId, job.data.invoiceId, { finalAttempt });
    }
}

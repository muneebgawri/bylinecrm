import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { INVOICE_VERIFY_JOB, INVOICE_VERIFY_QUEUE } from './invoices.constants';

export interface InvoiceVerifyJob {
    workspaceId: string;
    invoiceId: string;
}

/**
 * The one way an invoice gets verified in the background (INV-1). One job per invoice; asking again while one
 * waits is the same job. Never throws: Redis down is logged and the invoice stays `verifying`, which a person can
 * re-check.
 */
@Injectable()
export class InvoiceQueue {
    private readonly logger = new Logger(InvoiceQueue.name);

    constructor(@InjectQueue(INVOICE_VERIFY_QUEUE) private readonly queue: Queue<InvoiceVerifyJob>) {}

    async enqueue(job: InvoiceVerifyJob): Promise<void> {
        try {
            const existing = await this.queue.getJob(job.invoiceId);
            if (existing) {
                const state = await existing.getState();
                if (state === 'active' || state === 'waiting' || state === 'delayed') return;
                await existing.remove();
            }
            await this.queue.add(INVOICE_VERIFY_JOB, job, { jobId: job.invoiceId });
        } catch (error) {
            this.logger.error(
                `could not queue verification of invoice ${job.invoiceId}: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }
}

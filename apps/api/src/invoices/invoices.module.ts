import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { InvoiceQueue } from './invoice-queue';
import { INVOICE_VERIFY_ATTEMPTS, INVOICE_VERIFY_BACKOFF_MS, INVOICE_VERIFY_QUEUE } from './invoices.constants';
import { InvoicesController, NewswireosHookController, NewswireosSettingsController } from './invoices.controllers';
import { InvoicesService } from './invoices.service';
import { InvoicesWorkers } from './invoices.workers';
import { NewswireosHookService } from './newswireos-hook.service';
import { NewswireosSettingsService } from './newswireos-settings.service';
import { NewswireosVerificationHttp } from './newswireos-verification.http';
import { NEWSWIREOS_VERIFICATION_PORT } from './newswireos-verification.port';

/**
 * Invoices on a deal (INV-1, FR-CRMS-19): references verified by NewswireOS through a port (the HTTP adapter here;
 * the suite's fake in tests), in the background (`INVOICE_WORKER`); the workspace's NewswireOS link; and the hook
 * NewswireOS reports refunds and chargebacks to. Contract: docs/design-notes/INV-1.md.
 */
@Module({
    imports: [
        AuthModule,
        BullModule.registerQueue({
            name: INVOICE_VERIFY_QUEUE,
            defaultJobOptions: {
                attempts: INVOICE_VERIFY_ATTEMPTS,
                backoff: { type: 'exponential', delay: INVOICE_VERIFY_BACKOFF_MS },
                removeOnComplete: true,
                removeOnFail: true,
            },
        }),
    ],
    controllers: [InvoicesController, NewswireosSettingsController, NewswireosHookController],
    providers: [
        { provide: NEWSWIREOS_VERIFICATION_PORT, useClass: NewswireosVerificationHttp },
        InvoiceQueue,
        InvoicesService,
        InvoicesWorkers,
        NewswireosSettingsService,
        NewswireosHookService,
    ],
})
export class InvoicesModule {}

import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { NewswireosDealWonHttp } from './deal-won-push.http';
import { NEWSWIREOS_DEAL_WON_PORT } from './deal-won-push.port';
import { DealWonPushService } from './deal-won-push.service';
import { DealWonPushSubscriber } from './deal-won-push.subscriber';
import { DealWonPushWorker } from './deal-won-push.worker';
import { InvoiceQueue } from './invoice-queue';
import {
    DEAL_WON_PUSH_QUEUE,
    INVOICE_VERIFY_ATTEMPTS,
    INVOICE_VERIFY_BACKOFF_MS,
    INVOICE_VERIFY_QUEUE,
    OWNERSHIP_PUSH_ATTEMPTS,
    OWNERSHIP_PUSH_BACKOFF_MS,
    OWNERSHIP_PUSH_QUEUE,
} from './invoices.constants';
import {
    InvoicesController,
    NewswireosHookController,
    NewswireosPaymentsController,
    NewswireosSettingsController,
} from './invoices.controllers';
import { InvoicesService } from './invoices.service';
import { InvoicesWorkers } from './invoices.workers';
import { NewswireosHookService } from './newswireos-hook.service';
import { NewswireosSettingsService } from './newswireos-settings.service';
import { NewswireosPaymentsService } from './newswireos-payments.service';
import { RecordsModule } from '../records/records.module';
import { NewswireosTimelineService } from './newswireos-timeline.service';
import { NewswireosVerificationHttp } from './newswireos-verification.http';
import { NEWSWIREOS_VERIFICATION_PORT } from './newswireos-verification.port';
import { NewswireosOwnershipHttp } from './ownership-push.http';
import { NEWSWIREOS_OWNERSHIP_PORT } from './ownership-push.port';
import { OwnershipPushService } from './ownership-push.service';
import { OwnershipPushSubscriber } from './ownership-push.subscriber';
import { OwnershipPushWorker } from './ownership-push.worker';

/**
 * Invoices on a deal (INV-1, FR-CRMS-19): references verified by NewswireOS through a port (the HTTP adapter here;
 * the suite's fake in tests), in the background (`INVOICE_WORKER`); the workspace's NewswireOS link; and the hook
 * NewswireOS reports refunds and chargebacks to. Contract: docs/design-notes/INV-1.md. And (PNW-765) completed ownership
 * transfers pushed to NewswireOS, when an admin turns it on. And (PNW-766) won deals pushed to NewswireOS, which makes
 * their contacts clients, and NewswireOS's client activity on the timeline through the same hook.
 */
@Module({
    imports: [
        AuthModule,
        RecordsModule,
        BullModule.registerQueue({
            name: INVOICE_VERIFY_QUEUE,
            defaultJobOptions: {
                attempts: INVOICE_VERIFY_ATTEMPTS,
                backoff: { type: 'exponential', delay: INVOICE_VERIFY_BACKOFF_MS },
                removeOnComplete: true,
                removeOnFail: true,
            },
        }),
        BullModule.registerQueue({
            name: DEAL_WON_PUSH_QUEUE,
            defaultJobOptions: {
                attempts: OWNERSHIP_PUSH_ATTEMPTS,
                backoff: { type: 'exponential', delay: OWNERSHIP_PUSH_BACKOFF_MS },
                removeOnComplete: true,
                removeOnFail: true,
            },
        }),
        BullModule.registerQueue({
            name: OWNERSHIP_PUSH_QUEUE,
            defaultJobOptions: {
                attempts: OWNERSHIP_PUSH_ATTEMPTS,
                backoff: { type: 'exponential', delay: OWNERSHIP_PUSH_BACKOFF_MS },
                removeOnComplete: true,
                removeOnFail: true,
            },
        }),
    ],
    controllers: [
        InvoicesController,
        NewswireosSettingsController,
        NewswireosHookController,
        NewswireosPaymentsController,
    ],
    providers: [
        { provide: NEWSWIREOS_VERIFICATION_PORT, useClass: NewswireosVerificationHttp },
        InvoiceQueue,
        InvoicesService,
        InvoicesWorkers,
        NewswireosSettingsService,
        NewswireosHookService,
        { provide: NEWSWIREOS_OWNERSHIP_PORT, useClass: NewswireosOwnershipHttp },
        OwnershipPushService,
        OwnershipPushSubscriber,
        OwnershipPushWorker,
        { provide: NEWSWIREOS_DEAL_WON_PORT, useClass: NewswireosDealWonHttp },
        DealWonPushService,
        DealWonPushSubscriber,
        DealWonPushWorker,
        NewswireosTimelineService,
        NewswireosPaymentsService,
    ],
})
export class InvoicesModule {}

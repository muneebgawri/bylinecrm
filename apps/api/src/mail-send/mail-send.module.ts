import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MailAccountsModule } from '../mail-accounts/mail-accounts.module';
import { MailSyncModule } from '../mail-sync/mail-sync.module';
import { SendingPoolModule } from '../sending-pool/sending-pool.module';
import { SuppressionModule } from '../suppression/suppression.module';
import { TemplatesModule } from '../templates/templates.module';
import {
    MAIL_SEND_JOB_ATTEMPTS,
    MAIL_SEND_JOB_BACKOFF_MS,
    MAIL_SEND_MAINTENANCE_QUEUE,
    MAIL_SEND_QUEUE,
} from './mail-send.constants';
import { MailSendController } from './mail-send.controller';
import { MailSendService } from './mail-send.service';
import { MailSendWorkers } from './mail-send.workers';
import { SendPolicy } from './send-policy';
import { MailSendSweep } from './sweep';

/**
 * Sending (P2-3, P2-5): the send route (now or scheduled) and its status, scheduled sends' list,
 * cancel and move, the sweep that re-enqueues sends whose job was lost, the job that sends through
 * Gmail, and the policy every send passes — whose suppression check is `SuppressionModule`'s (P3-1).
 * Gmail, its quota and retry, and the writer that stores what was sent are mail sync's
 * (`MailSyncModule`); templates render through `TemplatesModule`. Reply detection lives in sync's
 * writer, where every inbound message passes.
 */
@Module({
    imports: [
        AuthModule,
        MailAccountsModule,
        MailSyncModule,
        SendingPoolModule,
        SuppressionModule,
        TemplatesModule,
        BullModule.registerQueue({
            name: MAIL_SEND_QUEUE,
            defaultJobOptions: {
                attempts: MAIL_SEND_JOB_ATTEMPTS,
                backoff: { type: 'exponential', delay: MAIL_SEND_JOB_BACKOFF_MS },
                removeOnComplete: true,
                removeOnFail: true,
            },
        }),
        BullModule.registerQueue({
            name: MAIL_SEND_MAINTENANCE_QUEUE,
            defaultJobOptions: { removeOnComplete: true, removeOnFail: true },
        }),
    ],
    controllers: [MailSendController],
    providers: [MailSendService, MailSendWorkers, MailSendSweep, SendPolicy],
})
export class MailSendModule {}

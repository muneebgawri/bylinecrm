import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { MailAccountsModule } from '../mail-accounts/mail-accounts.module';
import { BlocklistService } from './blocklist.service';
import { GmailHttp } from './gmail.http';
import { GMAIL_PORT } from './gmail.port';
import { BlocklistController, MailThreadsController, MailboxSyncController } from './mail-sync.controllers';
import { MAIL_SYNC_JOB_ATTEMPTS, MAIL_SYNC_JOB_BACKOFF_MS, MAIL_SYNC_QUEUE } from './mail-sync.constants';
import { MailReadService } from './mail-read.service';
import { MailSyncService } from './mail-sync.service';
import { MailSyncSubscriber } from './mail-sync.subscriber';
import { MailSyncWorkers } from './mail-sync.workers';
import { GmailQuota } from './quota';

/**
 * Mail sync (P2-2): Gmail behind `GMAIL_PORT` (the HTTP adapter here, a fake in tests), the sync
 * engine and its queue, the subscriber that starts a first import and re-matches mail when people
 * change, and the routes that read synced mail and the blocklist. The queue's connection is the
 * application's (BullMQ's root module, registered by the webhooks module).
 */
@Module({
    imports: [
        AuthModule,
        MailAccountsModule,
        BullModule.registerQueue({
            name: MAIL_SYNC_QUEUE,
            defaultJobOptions: {
                attempts: MAIL_SYNC_JOB_ATTEMPTS,
                backoff: { type: 'exponential', delay: MAIL_SYNC_JOB_BACKOFF_MS },
                removeOnComplete: true,
                removeOnFail: true,
            },
        }),
    ],
    controllers: [MailThreadsController, MailboxSyncController, BlocklistController],
    providers: [
        { provide: GMAIL_PORT, useClass: GmailHttp },
        GmailQuota,
        MailSyncService,
        MailReadService,
        BlocklistService,
        MailSyncWorkers,
        MailSyncSubscriber,
    ],
})
export class MailSyncModule {}

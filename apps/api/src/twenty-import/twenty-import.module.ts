import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PipelinesModule } from '../pipelines/pipelines.module';
import { CustomFieldsModule } from '../records/custom-fields/custom-fields.module';
import { RecordsModule } from '../records/records.module';
import { SequencesModule } from '../sequences/sequences.module';
import { TemplatesModule } from '../templates/templates.module';
import { TimelineModule } from '../timeline/timeline.module';
import { TransactionalMailModule } from '../transactional-mail/transactional-mail.module';
import { ViewsModule } from '../views/views.module';
import { TwentyImportRunner } from './import-runner';
import {
    TWENTY_IMPORT_JOB_ATTEMPTS,
    TWENTY_IMPORT_JOB_BACKOFF_MS,
    TWENTY_IMPORT_QUEUE,
} from './twenty-import.constants';
import { TwentyImportController } from './twenty-import.controller';
import { TwentyImportService, twentyHttp } from './twenty-import.service';
import { TwentyImportWorkers } from './twenty-import.workers';
import { TwentySyncService } from './twenty-sync.service';
import { TWENTY_PORT } from './twenty.port';

/**
 * The Twenty importer (P4-4, doc 48 §11): Twenty behind `TWENTY_PORT` (the HTTP adapter here, a
 * fake in tests), the runner that writes through the record, exclusion, view and template services
 * — so an imported record is validated, placed and announced like any other — the automatic sync
 * (#185: its bookkeeping, the admins' mail, and the timeline it asks about local edits) and the
 * routes. The queue's connection is the application's (BullMQ's root module, registered by the
 * webhooks module).
 */
@Module({
    imports: [
        AuthModule,
        RecordsModule,
        CustomFieldsModule,
        PipelinesModule,
        SequencesModule,
        ViewsModule,
        TemplatesModule,
        TimelineModule,
        TransactionalMailModule,
        BullModule.registerQueue({
            name: TWENTY_IMPORT_QUEUE,
            defaultJobOptions: {
                attempts: TWENTY_IMPORT_JOB_ATTEMPTS,
                backoff: { type: 'exponential', delay: TWENTY_IMPORT_JOB_BACKOFF_MS },
                removeOnComplete: true,
                removeOnFail: true,
            },
        }),
    ],
    controllers: [TwentyImportController],
    providers: [
        { provide: TWENTY_PORT, useFactory: twentyHttp },
        TwentyImportRunner,
        TwentySyncService,
        TwentyImportWorkers,
        TwentyImportService,
    ],
})
export class TwentyImportModule {}

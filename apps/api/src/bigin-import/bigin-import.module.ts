import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PipelinesModule } from '../pipelines/pipelines.module';
import { CustomFieldsModule } from '../records/custom-fields/custom-fields.module';
import { RecordsModule } from '../records/records.module';
import { TimelineModule } from '../timeline/timeline.module';
import { TransactionalMailModule } from '../transactional-mail/transactional-mail.module';
import { BIGIN_IMPORT_JOB_ATTEMPTS, BIGIN_IMPORT_JOB_BACKOFF_MS, BIGIN_IMPORT_QUEUE } from './bigin-import.constants';
import { BiginImportController } from './bigin-import.controller';
import { BiginImportService, biginHttp } from './bigin-import.service';
import { BiginImportWorkers } from './bigin-import.workers';
import { BiginSyncService } from './bigin-sync.service';
import { BIGIN_PORT } from './bigin.port';
import { BiginImportRunner } from './import-runner';

/**
 * The Bigin importer (BIGIN-1, FR-CRMS-25): Zoho Bigin behind `BIGIN_PORT` (the HTTP adapter here, a fake
 * in tests), the runner that writes through the record services, the automatic sync, and the routes.
 * Nothing here is read at boot: a workspace configures Bigin on its settings screen, so a deployment
 * without Bigin starts as before.
 */
@Module({
    imports: [
        AuthModule,
        RecordsModule,
        CustomFieldsModule,
        PipelinesModule,
        TimelineModule,
        TransactionalMailModule,
        BullModule.registerQueue({
            name: BIGIN_IMPORT_QUEUE,
            defaultJobOptions: {
                attempts: BIGIN_IMPORT_JOB_ATTEMPTS,
                backoff: { type: 'exponential', delay: BIGIN_IMPORT_JOB_BACKOFF_MS },
                removeOnComplete: true,
                removeOnFail: true,
            },
        }),
    ],
    controllers: [BiginImportController],
    providers: [
        { provide: BIGIN_PORT, useFactory: biginHttp },
        BiginImportRunner,
        BiginSyncService,
        BiginImportWorkers,
        BiginImportService,
    ],
})
export class BiginImportModule {}

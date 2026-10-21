import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TransfersModule } from '../transfers/transfers.module';
import { CadenceConsumer } from './cadence.consumer';
import { CadenceService } from './cadence.service';
import { CADENCE_QUEUE, CadenceWorkers } from './cadence.workers';
import { RotationController } from './rotation.controller';
import { RotationSettingsService } from './rotation-settings.service';
import { RotationService } from './rotation.service';

/** The round-robin itself: global, so intake (records, BylineAI) deals from it without importing the job. */
@Global()
@Module({ providers: [RotationService], exports: [RotationService] })
export class RotationModule {}

/**
 * Cadence and round-robin rotation (CADENCE-1, docs/design-notes/CADENCE-1.md): the hourly job that warns and
 * rotates, the consumer that keeps cadence current between runs, and Settings → Rotation.
 */
@Module({
    imports: [
        AuthModule,
        RotationModule,
        TransfersModule,
        BullModule.registerQueue({
            name: CADENCE_QUEUE,
            defaultJobOptions: { removeOnComplete: true, removeOnFail: true },
        }),
    ],
    controllers: [RotationController],
    providers: [CadenceService, CadenceConsumer, CadenceWorkers, RotationSettingsService],
    exports: [CadenceService],
})
export class CadenceModule {}

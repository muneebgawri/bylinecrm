import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SuppressionsController, UnsubscribeController } from './suppression.controllers';
import { SuppressionService } from './suppression.service';
import { UnsubscribeRateGuard } from './unsubscribe-rate.guard';
import { UnsubscribeService } from './unsubscribe.service';

/**
 * Suppression and unsubscribe (P3-1, FR-CRMS-7): the workspace's list, the one check every send and
 * enrolment makes (`SuppressionService.check`), the write P3-2's bounce and complaint ingestion uses
 * (`suppress`), unsubscribe links (`UnsubscribeService.issue`) and their public routes.
 */
@Module({
    imports: [AuthModule],
    controllers: [SuppressionsController, UnsubscribeController],
    providers: [SuppressionService, UnsubscribeService, UnsubscribeRateGuard],
    exports: [SuppressionService, UnsubscribeService],
})
export class SuppressionModule {}

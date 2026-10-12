import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SendingPoolModule } from '../sending-pool/sending-pool.module';
import { TrackingDomainService } from './tracking-domain.service';
import { TrackingRateGuard } from './tracking-rate.guard';
import { TrackingDomainController, TrackingPublicController } from './tracking.controllers';
import { TrackingService } from './tracking.service';

/**
 * Tracking (P3-4, FR-CRMS-8): the workspace's short-link domain and its CNAME check (through the
 * sending pool's DNS port), the send path's one call (`TrackingService.trackOutreach`), the public
 * redirect and pixel routes, and the counts the mail and sequence listings add to their views
 * (`tracking-counts.ts`). Design: docs/design-notes/P3-4.md.
 */
@Module({
    imports: [AuthModule, SendingPoolModule],
    controllers: [TrackingDomainController, TrackingPublicController],
    providers: [TrackingDomainService, TrackingService, TrackingRateGuard],
    exports: [TrackingService],
})
export class TrackingModule {}

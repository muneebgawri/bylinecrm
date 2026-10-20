import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RecordsModule } from '../records/records.module';
import { BylineInboundService } from './byline-inbound.service';
import { BylineSettingsService } from './byline-settings.service';
import { BylineInboundController, BylineSettingsController } from './byline.controllers';

/**
 * BylineAI, connected rather than folded in (BYL-1, spec §8): the receiver its WEBHOOK export connector posts leads
 * to, placing each by OWN-2's company-ownership rule, and the workspace's link. Contract: `@byline/contract`;
 * design note docs/design-notes/BYL.md.
 */
@Module({
    imports: [AuthModule, RecordsModule],
    controllers: [BylineSettingsController, BylineInboundController],
    providers: [BylineSettingsService, BylineInboundService],
})
export class BylineModule {}

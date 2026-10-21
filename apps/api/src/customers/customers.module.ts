import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RecordsModule } from '../records/records.module';
import { SequencesModule } from '../sequences/sequences.module';
import { SuppressionModule } from '../suppression/suppression.module';
import { ContactStatusConsumer } from './contact-status.consumer';
import { ContactStatusService } from './contact-status.service';
import { ContactStatusController, CustomerExclusionSettingsController } from './customers.controllers';
import { WonDealConsumer } from './won-deal.consumer';
import { WonDealExclusions } from './won-deal-exclusions';

/**
 * Who someone is to the workspace (#242): a person's contact status, derived and kept current by its consumer, and
 * won deals as customers — the outreach exclusion a won deal adds, its admin setting and its review flags.
 */
@Module({
    imports: [AuthModule, RecordsModule, SequencesModule, SuppressionModule],
    controllers: [ContactStatusController, CustomerExclusionSettingsController],
    providers: [ContactStatusService, ContactStatusConsumer, WonDealExclusions, WonDealConsumer],
})
export class CustomersModule {}

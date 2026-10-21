import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RecordsModule } from '../records/records.module';
import { SuppressionModule } from '../suppression/suppression.module';
import { TransactionalMailModule } from '../transactional-mail/transactional-mail.module';
import { GuardrailsController } from './guardrails.controller';
import { GuardrailsService } from './guardrails.service';
import { PoachDetector, PoachDetectorConsumer } from './poach-detector';
import { RecipientGuard } from './recipient-guard';

/**
 * Guardrails (GUARD-1, FR-CRMS-21): the recipient guard every outbound path asks — sending (`SendPolicy`) and
 * the enrolment screen — and the Guardrails page that reads what it did. Ownership is OWN-2's
 * (`CompanyOwnership`), suppression P3-1's. GUARD-2: the poaching detector on mail that left (`PoachDetector`, an
 * outbox consumer of `email.sent` / `email.received`) and the admin view of members whose mail sync does not see.
 */
@Module({
    imports: [AuthModule, RecordsModule, SuppressionModule, TransactionalMailModule],
    controllers: [GuardrailsController],
    providers: [GuardrailsService, RecipientGuard, PoachDetector, PoachDetectorConsumer],
    exports: [RecipientGuard, PoachDetector],
})
export class GuardrailsModule {}

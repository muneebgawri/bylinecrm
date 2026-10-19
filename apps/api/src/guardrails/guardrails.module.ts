import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RecordsModule } from '../records/records.module';
import { SuppressionModule } from '../suppression/suppression.module';
import { GuardrailsController } from './guardrails.controller';
import { GuardrailsService } from './guardrails.service';
import { RecipientGuard } from './recipient-guard';

/**
 * Guardrails (GUARD-1, FR-CRMS-21): the recipient guard every outbound path asks — sending (`SendPolicy`) and
 * the enrolment screen — and the Guardrails page that reads what it did. Ownership is OWN-2's
 * (`CompanyOwnership`), suppression P3-1's.
 */
@Module({
    imports: [AuthModule, RecordsModule, SuppressionModule],
    controllers: [GuardrailsController],
    providers: [GuardrailsService, RecipientGuard],
    exports: [RecipientGuard],
})
export class GuardrailsModule {}

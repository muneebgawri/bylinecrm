import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AuthModule } from './auth/auth.module';
import { CalendarModule } from './calendar/calendar.module';
import { ConfigModule } from './config/config.module';
import { EventsModule } from './events/events.module';
import { GuardrailsModule } from './guardrails/guardrails.module';
import { BylineModule } from './byline/byline.module';
import { InvoicesModule } from './invoices/invoices.module';
import { HealthModule } from './health/health.module';
import { ErrorFilter } from './infra/errors/error.filter';
import { InfraModule } from './infra/infra.module';
import { MailAccountsModule } from './mail-accounts/mail-accounts.module';
import { MailSendModule } from './mail-send/mail-send.module';
import { MailSyncModule } from './mail-sync/mail-sync.module';
import { PipelinesModule } from './pipelines/pipelines.module';
import { SendingPoolModule } from './sending-pool/sending-pool.module';
import { NotificationsModule } from './notifications/notifications.module';
import { SequencesModule } from './sequences/sequences.module';
import { SignaturesModule } from './signatures/signatures.module';
import { EnrichmentModule } from './enrichment/enrichment.module';
import { VerificationModule } from './verification/verification.module';
import { SuppressionModule } from './suppression/suppression.module';
import { PlatformModule } from './platform/platform.module';
import { RecordsModule } from './records/records.module';
import { TemplatesModule } from './templates/templates.module';
import { TimelineModule } from './timeline/timeline.module';
import { TransfersModule } from './transfers/transfers.module';
import { TrackingModule } from './tracking/tracking.module';
import { TwentyImportModule } from './twenty-import/twenty-import.module';
import { BiginImportModule } from './bigin-import/bigin-import.module';
import { ViewsModule } from './views/views.module';
import { WebhooksModule } from './webhooks/webhooks.module';

@Module({
    imports: [
        ConfigModule,
        InfraModule,
        EventsModule,
        GuardrailsModule,
        InvoicesModule,
        BylineModule,
        HealthModule,
        AuthModule,
        MailAccountsModule,
        MailSyncModule,
        MailSendModule,
        PipelinesModule,
        PlatformModule,
        RecordsModule,
        SuppressionModule,
        SendingPoolModule,
        SequencesModule,
        SignaturesModule,
        NotificationsModule,
        VerificationModule,
        EnrichmentModule,
        TemplatesModule,
        TimelineModule,
        TransfersModule,
        TrackingModule,
        TwentyImportModule,
        BiginImportModule,
        ViewsModule,
        WebhooksModule,
        CalendarModule,
    ],
    // The one place an exception becomes a response: every error leaves as `ApiErrorBody` (P1-1d).
    providers: [{ provide: APP_FILTER, useClass: ErrorFilter }],
})
export class AppModule {}

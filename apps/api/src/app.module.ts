import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AuthModule } from './auth/auth.module';
import { ConfigModule } from './config/config.module';
import { EventsModule } from './events/events.module';
import { HealthModule } from './health/health.module';
import { ErrorFilter } from './infra/errors/error.filter';
import { InfraModule } from './infra/infra.module';
import { MailAccountsModule } from './mail-accounts/mail-accounts.module';
import { MailSyncModule } from './mail-sync/mail-sync.module';
import { PipelinesModule } from './pipelines/pipelines.module';
import { RecordsModule } from './records/records.module';
import { TemplatesModule } from './templates/templates.module';
import { TimelineModule } from './timeline/timeline.module';
import { ViewsModule } from './views/views.module';
import { WebhooksModule } from './webhooks/webhooks.module';

@Module({
    imports: [
        ConfigModule,
        InfraModule,
        EventsModule,
        HealthModule,
        AuthModule,
        MailAccountsModule,
        MailSyncModule,
        PipelinesModule,
        RecordsModule,
        TemplatesModule,
        TimelineModule,
        ViewsModule,
        WebhooksModule,
    ],
    // The one place an exception becomes a response: every error leaves as `ApiErrorBody` (P1-1d).
    providers: [{ provide: APP_FILTER, useClass: ErrorFilter }],
})
export class AppModule {}

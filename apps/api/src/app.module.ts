import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { ConfigModule } from './config/config.module';
import { EventsModule } from './events/events.module';
import { HealthModule } from './health/health.module';
import { InfraModule } from './infra/infra.module';
import { PipelinesModule } from './pipelines/pipelines.module';
import { RecordsModule } from './records/records.module';

@Module({
    imports: [ConfigModule, InfraModule, EventsModule, HealthModule, AuthModule, PipelinesModule, RecordsModule],
})
export class AppModule {}

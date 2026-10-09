import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { ConfigModule } from './config/config.module';
import { EventsModule } from './events/events.module';
import { HealthModule } from './health/health.module';
import { InfraModule } from './infra/infra.module';
import { RecordsModule } from './records/records.module';
import { TimelineModule } from './timeline/timeline.module';

@Module({
    imports: [ConfigModule, InfraModule, EventsModule, HealthModule, AuthModule, RecordsModule, TimelineModule],
})
export class AppModule {}

import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module';
import { HealthModule } from './health/health.module';
import { InfraModule } from './infra/infra.module';

@Module({
    imports: [ConfigModule, InfraModule, HealthModule],
})
export class AppModule {}

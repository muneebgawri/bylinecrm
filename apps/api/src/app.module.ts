import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { ConfigModule } from './config/config.module';
import { HealthModule } from './health/health.module';
import { InfraModule } from './infra/infra.module';

@Module({
    imports: [ConfigModule, InfraModule, HealthModule, AuthModule],
})
export class AppModule {}

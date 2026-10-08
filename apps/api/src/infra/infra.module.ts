import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { RedisService } from './redis.service';

/** Infrastructure clients, one instance each, available to every module. */
@Global()
@Module({
    providers: [PrismaService, RedisService],
    exports: [PrismaService, RedisService],
})
export class InfraModule {}

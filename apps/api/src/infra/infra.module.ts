import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { RedisService } from './redis.service';
import { RlsPrismaService } from './rls-prisma.service';
import { WorkspaceContext } from './workspace-context';

/**
 * Infrastructure clients, one instance each, available to every module: the owner database
 * client, the restricted (RLS) client with its workspace context, and Redis.
 */
@Global()
@Module({
    providers: [PrismaService, RlsPrismaService, WorkspaceContext, RedisService],
    exports: [PrismaService, RlsPrismaService, WorkspaceContext, RedisService],
})
export class InfraModule {}

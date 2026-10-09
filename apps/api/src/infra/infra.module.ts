import { Global, Module } from '@nestjs/common';
import { ENV, type Env } from '../config/env';
import { PrismaService } from './prisma.service';
import { RedisService } from './redis.service';
import { RlsPrismaService } from './rls-prisma.service';
import { SecretBox } from './secret-box';
import { FILE_STORAGE } from './storage/file-storage';
import { LocalDiskStorage } from './storage/local-disk-storage';
import { WorkspaceContext } from './workspace-context';

/**
 * Infrastructure clients, one instance each, available to every module: the owner database
 * client, the restricted (RLS) client with its workspace context, Redis, the secrets box and the
 * file store.
 * The file store is the local-disk driver for now; swapping the driver happens here and only here.
 */
@Global()
@Module({
    providers: [
        PrismaService,
        RlsPrismaService,
        WorkspaceContext,
        RedisService,
        SecretBox,
        {
            provide: FILE_STORAGE,
            inject: [ENV],
            useFactory: (env: Env) => new LocalDiskStorage(env.FILE_STORAGE_ROOT),
        },
    ],
    exports: [PrismaService, RlsPrismaService, WorkspaceContext, RedisService, SecretBox, FILE_STORAGE],
})
export class InfraModule {}

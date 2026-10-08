import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * The owner Prisma client: migrations, administration, and the few operations that must see
 * across workspaces (creating one, for instance). It bypasses row-level security because the
 * owner does, so it is never used to answer a request for tenant data — that is
 * `RlsPrismaService.withWorkspace`. Injected as `ownerPrisma` wherever it appears so the choice
 * is visible at the call site.
 *
 * Connected on module init so a bad DATABASE_URL fails at boot, not on first use.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
    async onModuleInit(): Promise<void> {
        await this.$connect();
    }

    async onModuleDestroy(): Promise<void> {
        await this.$disconnect();
    }
}

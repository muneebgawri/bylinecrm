import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { ENV, type Env } from '../config/env';
import { OWNER_POOL_SIZE } from './rls-pool.constants';
import { withPoolDefaults } from './rls-prisma.service';

/**
 * The owner Prisma client: migrations, administration, and the few operations that must see
 * across workspaces (creating one, for instance). It bypasses row-level security because the
 * owner does, so it is never used to answer a request for tenant data — that is
 * `RlsPrismaService.withWorkspace`. Injected as `ownerPrisma` wherever it appears so the choice
 * is visible at the call site.
 *
 * Its pool is sized like the tenant pools (`OWNER_POOL_SIZE`, #86), so one process's total
 * connections are a known sum (see `rls-pool.constants.ts`) rather than Prisma's CPU-based default.
 *
 * Connected on module init so a bad DATABASE_URL fails at boot, not on first use.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
    constructor(@Inject(ENV) env: Env) {
        super({ datasourceUrl: withPoolDefaults(env.DATABASE_URL, OWNER_POOL_SIZE) });
    }

    async onModuleInit(): Promise<void> {
        await this.$connect();
    }

    async onModuleDestroy(): Promise<void> {
        await this.$disconnect();
    }
}

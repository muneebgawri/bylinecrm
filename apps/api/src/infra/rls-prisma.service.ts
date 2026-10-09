import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { USER_SETTING, WORKSPACE_SETTING } from '@bylinecrm/shared';
import { ENV, type Env } from '../config/env';
import {
    POOL_EXHAUSTED_CODE,
    POOL_RETRY_ATTEMPTS,
    POOL_RETRY_BASE_MS,
    RLS_POOL_SIZE,
    RLS_POOL_TIMEOUT_S,
} from './rls-pool.constants';
import { WorkspaceContext } from './workspace-context';

/** The client handed to a `withWorkspace` callback: the transaction, already scoped. */
export type WorkspaceClient = Prisma.TransactionClient;

/** Thrown when tenant data is asked for and nobody said which tenant. */
export class NoWorkspaceError extends Error {
    constructor() {
        super('withWorkspace called with no workspace: pass an id or run inside WorkspaceContext');
        this.name = 'NoWorkspaceError';
    }
}

/**
 * The restricted Prisma client: logs in as the app role, so every row it can see is a row the
 * policies allow. Tenant queries go through `withWorkspace`, which opens a transaction and sets
 * the workspace for it before the callback runs. The owner client (`PrismaService`) is for
 * migrations and administration and never touches tenant rows on a request's behalf.
 */
@Injectable()
export class RlsPrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
    constructor(
        @Inject(ENV) env: Env,
        private readonly context: WorkspaceContext,
    ) {
        super({ datasourceUrl: withPoolDefaults(env.RLS_DATABASE_URL) });
    }

    async onModuleInit(): Promise<void> {
        await this.$connect();
    }

    async onModuleDestroy(): Promise<void> {
        await this.$disconnect();
    }

    /** Runs `fn` in a transaction scoped to `workspaceId` (or to the ambient `WorkspaceContext`). */
    async withWorkspace<T>(fn: (tx: WorkspaceClient) => Promise<T>): Promise<T>;
    async withWorkspace<T>(workspaceId: string, fn: (tx: WorkspaceClient) => Promise<T>): Promise<T>;
    async withWorkspace<T>(
        idOrFn: string | ((tx: WorkspaceClient) => Promise<T>),
        maybeFn?: (tx: WorkspaceClient) => Promise<T>,
    ): Promise<T> {
        const explicit = typeof idOrFn === 'string';
        const fn = explicit ? maybeFn : idOrFn;
        const workspaceId = explicit ? idOrFn : this.context.get()?.workspaceId;
        if (!workspaceId) throw new NoWorkspaceError();
        if (!fn) throw new TypeError('withWorkspace needs a callback');

        return this.scoped(WORKSPACE_SETTING, workspaceId, fn);
    }

    /**
     * Runs `fn` in a transaction that knows only who the caller is, not which workspace: the
     * policies then show the user their own row and their own memberships, which is what the
     * workspace guard needs before any workspace is chosen. Tenant tables stay invisible.
     */
    withUser<T>(userId: string, fn: (tx: WorkspaceClient) => Promise<T>): Promise<T> {
        return this.scoped(USER_SETTING, userId, fn);
    }

    /**
     * One transaction, one transaction-local setting (`set_config(..., true)`), bound as a
     * parameter so it can neither outlive the transaction nor be string-built. A pool-exhausted
     * error is retried with a bounded, doubling delay; any other error propagates.
     */
    private async scoped<T>(setting: string, value: string, fn: (tx: WorkspaceClient) => Promise<T>): Promise<T> {
        for (let attempt = 1; ; attempt++) {
            try {
                return await this.$transaction(async (tx) => {
                    await tx.$executeRaw`SELECT set_config(${setting}, ${value}, true)`;
                    return fn(tx);
                });
            } catch (error) {
                if (!isPoolExhausted(error) || attempt >= POOL_RETRY_ATTEMPTS) throw error;
                await sleep(POOL_RETRY_BASE_MS * 2 ** (attempt - 1));
            }
        }
    }
}

/** Applies the pool constants unless the URL sets its own; an operator's explicit value wins. */
export function withPoolDefaults(url: string): string {
    const parsed = new URL(url);
    if (!parsed.searchParams.has('connection_limit')) {
        parsed.searchParams.set('connection_limit', String(RLS_POOL_SIZE));
    }
    if (!parsed.searchParams.has('pool_timeout')) {
        parsed.searchParams.set('pool_timeout', String(RLS_POOL_TIMEOUT_S));
    }
    return parsed.toString();
}

function isPoolExhausted(error: unknown): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === POOL_EXHAUSTED_CODE;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

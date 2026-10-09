import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { OWNER_SETTING, USER_SETTING, WORKSPACE_SETTING } from '@bylinecrm/shared';
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
    /** Who hears the operations of which request; see `observeQueries`. */
    private readonly queryObservers = new Map<(query: ObservedQuery) => void, string>();
    private readonly queryEvents: boolean;
    /**
     * With `DB_QUERY_EVENTS=1`, the client every transaction runs on: the same client extended with
     * a hook that sees each operation in the async context of the code that issued it — which a
     * Prisma statement event does not (its callback runs in no request's context). Null otherwise.
     */
    private readonly observed: Pick<PrismaClient, '$transaction'> | null;

    constructor(
        @Inject(ENV) env: Env,
        private readonly context: WorkspaceContext,
    ) {
        super({ datasourceUrl: withPoolDefaults(env.RLS_DATABASE_URL) });
        this.queryEvents = env.DB_QUERY_EVENTS;
        this.observed = this.queryEvents
            ? (this.$extends({
                  query: {
                      $allOperations: ({ model, operation, args, query }) => {
                          this.notify(() => ({ model: model ?? null, operation, sql: sqlOf(args) }));
                          return query(args);
                      },
                  },
              }) as unknown as Pick<PrismaClient, '$transaction'>)
            : null;
    }

    /**
     * Hears every operation one request sends — the request whose `X-Request-Id` is
     * `scope.requestId` — until the returned function is called. Work running at the same time in
     * any other context (another request, a background listener of an earlier one, a job) is not
     * heard, so a query budget measures the request alone: the record lists' test asserts that a
     * page of fifty rows with their related names costs as many operations as a page of ten
     * (P1-4a: no N+1). Needs `DB_QUERY_EVENTS=1`; without it this throws, so a test that forgot the
     * flag fails instead of counting nothing and passing.
     */
    observeQueries(observer: (query: ObservedQuery) => void, scope: { requestId: string }): () => void {
        if (!this.queryEvents) {
            throw new Error('observeQueries needs DB_QUERY_EVENTS=1: this client emits no query events');
        }
        this.queryObservers.set(observer, scope.requestId);
        return () => this.queryObservers.delete(observer);
    }

    /** Tells the observers of the current request about an operation; described only if someone listens. */
    private notify(describe: () => ObservedQuery): void {
        if (this.queryObservers.size === 0) return;
        const requestId = this.context.requestId();
        if (!requestId) return;
        let query: ObservedQuery | null = null;
        for (const [observe, observed] of this.queryObservers) {
            if (observed !== requestId) continue;
            query ??= describe();
            observe(query);
        }
    }

    async onModuleInit(): Promise<void> {
        await this.$connect();
    }

    async onModuleDestroy(): Promise<void> {
        await this.$disconnect();
    }

    /**
     * Runs `fn` in a transaction scoped to `workspaceId` (or to the ambient `WorkspaceContext`).
     * When the context says the caller is own-scoped in that workspace, the owner setting is set
     * in the same transaction, so the restrictive policies narrow every query inside `fn`.
     */
    async withWorkspace<T>(fn: (tx: WorkspaceClient) => Promise<T>): Promise<T>;
    async withWorkspace<T>(workspaceId: string, fn: (tx: WorkspaceClient) => Promise<T>): Promise<T>;
    async withWorkspace<T>(
        idOrFn: string | ((tx: WorkspaceClient) => Promise<T>),
        maybeFn?: (tx: WorkspaceClient) => Promise<T>,
    ): Promise<T> {
        const explicit = typeof idOrFn === 'string';
        const fn = explicit ? maybeFn : idOrFn;
        const current = this.context.get();
        const workspaceId = explicit ? idOrFn : current?.workspaceId;
        if (!workspaceId) throw new NoWorkspaceError();
        if (!fn) throw new TypeError('withWorkspace needs a callback');

        const settings: [string, string][] = [[WORKSPACE_SETTING, workspaceId]];
        const owner = current?.workspaceId === workspaceId ? current.ownerScopeMemberId : undefined;
        if (owner) settings.push([OWNER_SETTING, owner]);
        return this.scoped(settings, fn);
    }

    /**
     * Runs `fn` in a transaction that knows only who the caller is, not which workspace: the
     * policies then show the user their own row and their own memberships, which is what the
     * workspace guard needs before any workspace is chosen. Tenant tables stay invisible.
     */
    withUser<T>(userId: string, fn: (tx: WorkspaceClient) => Promise<T>): Promise<T> {
        return this.scoped([[USER_SETTING, userId]], fn);
    }

    /**
     * One transaction, its transaction-local settings (`set_config(..., true)`), each bound as a
     * parameter so it can neither outlive the transaction nor be string-built. A pool-exhausted
     * error is retried with a bounded, doubling delay; any other error propagates.
     */
    private async scoped<T>(
        settings: readonly (readonly [string, string])[],
        fn: (tx: WorkspaceClient) => Promise<T>,
    ): Promise<T> {
        for (let attempt = 1; ; attempt++) {
            try {
                return await (this.observed ?? this).$transaction(async (tx) => {
                    const client = tx as WorkspaceClient;
                    for (const [setting, value] of settings) {
                        await client.$executeRaw`SELECT set_config(${setting}, ${value}, true)`;
                    }
                    return fn(client);
                });
            } catch (error) {
                if (!isPoolExhausted(error) || attempt >= POOL_RETRY_ATTEMPTS) throw error;
                await sleep(POOL_RETRY_BASE_MS * 2 ** (attempt - 1));
            }
        }
    }
}

/** One operation a request sent: its model (null for a raw query) and, for a raw query, its SQL. */
export interface ObservedQuery {
    model: string | null;
    operation: string;
    sql: string | null;
}

/**
 * The SQL text of a raw operation's arguments — a tagged template's `Sql` (it has a `sql` string)
 * or an unsafe call's leading string; null for a model operation.
 */
function sqlOf(args: unknown): string | null {
    if (Array.isArray(args) && typeof args[0] === 'string') return args[0];
    const sql = (args as { sql?: unknown } | null)?.sql;
    return typeof sql === 'string' ? sql : null;
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

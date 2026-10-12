import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable } from '@nestjs/common';
import type { Actor, Capability } from '@bylinecrm/shared';

/** What a request (or a job) knows about its tenant once a guard has decided it may act there. */
export interface WorkspaceRunContext {
    workspaceId: string;
    /** The signed-in user, when the caller is a person rather than an API key. */
    userId?: string;
    /** The caller's seat in the workspace, when the caller is a person. */
    memberId?: string;
    /** The API key the caller presented, when the caller is a machine. */
    apiKeyId?: string;
    /** What the caller's role allows; `@Requires()` is checked against this. */
    capabilities: ReadonlySet<Capability>;
    /** The role the guard resolved the capabilities from, for the caller's own standing (`/me`). */
    roleId?: string;
    roleName?: string;
    /**
     * Set when the caller's role is scoped to its own records (`recordScope: 'own'`): the member
     * whose records they are. `withWorkspace` passes it to the restrictive policies; the record
     * services filter by it. Absent means every owner.
     */
    ownerScopeMemberId?: string;
    /**
     * Who the records written in this scope say made them, when it is not the caller: a job that
     * acts as an import (`{ kind: 'import', id: <run id> }`). Absent, `actorOf` derives the actor
     * from the caller — the member, else the key, else the system.
     */
    actor?: Actor;
}

/** The store for one request or job: empty until a guard fills it. */
interface Scope {
    /**
     * Whose scope this is: a request's (opened by `begin`) or a job's (opened by `run`). Decides the
     * tenant pool `withWorkspace` uses (#86): request work on the request pool, everything else —
     * jobs, sweeps, the listeners they trigger, code outside any scope — on the background pool.
     */
    kind: 'request' | 'job';
    workspace?: WorkspaceRunContext;
    /** The request's id (P1-1d), when the scope is a request's: what a query observer is tied to. */
    requestId?: string;
}

/**
 * The current workspace for the async call chain, carried without threading it through every
 * signature. A request middleware opens a scope with `begin`; the workspace guard fills it with
 * `set`; `withWorkspace` reads it when no explicit id is given. A job runner uses `run` to open
 * and fill in one step.
 *
 * `begin` rather than `enterWith`: a scope opened with `run` ends when its callback's chain
 * ends, so a keep-alive socket serving a second request cannot inherit the first one's tenant.
 *
 * This is not an authorization mechanism: a guard decides whether the caller may act in the
 * workspace, then records the decision here. Row-level security is the backstop underneath.
 */
@Injectable()
export class WorkspaceContext {
    private readonly storage = new AsyncLocalStorage<Scope>();

    /** Opens an empty scope for the chain started by `fn` (one per request), carrying the request's id. */
    begin<T>(fn: () => T, requestId?: string): T {
        return this.storage.run(requestId ? { kind: 'request', requestId } : { kind: 'request' }, fn);
    }

    /** True inside a request's scope; false in a job, a sweep, or outside any scope. */
    inRequest(): boolean {
        return this.storage.getStore()?.kind === 'request';
    }

    /** The id of the request this async chain belongs to; `undefined` outside a request. */
    requestId(): string | undefined {
        return this.storage.getStore()?.requestId;
    }

    /** Opens a scope already filled — for jobs and other non-request work. */
    run<T>(context: WorkspaceRunContext, fn: () => T): T {
        return this.storage.run({ kind: 'job', workspace: context }, fn);
    }

    /**
     * Runs `fn` outside every scope: neither the caller's request nor its job. For work a request
     * starts but does not own — the outbox relay a commit wakes (P1-6) — so it neither runs on the
     * request pool nor is counted by the request's query observers.
     */
    detached<T>(fn: () => T): T {
        return this.storage.exit(fn);
    }

    /** Records the guard's decision in the current scope. Throws outside any scope. */
    set(context: WorkspaceRunContext): void {
        const scope = this.storage.getStore();
        if (!scope) throw new Error('WorkspaceContext.set called outside a scope');
        scope.workspace = context;
    }

    /** The current context, or `undefined` outside any scope or before a guard has set it. */
    get(): WorkspaceRunContext | undefined {
        return this.storage.getStore()?.workspace;
    }
}

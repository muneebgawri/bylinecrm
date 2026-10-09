import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable } from '@nestjs/common';
import type { Capability } from '@bylinecrm/shared';

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
}

/** The store for one request or job: empty until a guard fills it. */
interface Scope {
    workspace?: WorkspaceRunContext;
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

    /** Opens an empty scope for the chain started by `fn` (one per request). */
    begin<T>(fn: () => T): T {
        return this.storage.run({}, fn);
    }

    /** Opens a scope already filled — for jobs and other non-request work. */
    run<T>(context: WorkspaceRunContext, fn: () => T): T {
        return this.storage.run({ workspace: context }, fn);
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

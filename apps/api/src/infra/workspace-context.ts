import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable } from '@nestjs/common';

/** What a request (or a job) knows about its tenant. P0-3 adds the user and their role. */
export interface WorkspaceRunContext {
    workspaceId: string;
}

/**
 * The current workspace for the async call chain, carried without threading it through every
 * signature. A request guard (P0-3) or a job runner populates it with `run`; `withWorkspace`
 * reads it when no explicit id is given.
 *
 * This is not an authorization mechanism: a guard decides whether the caller may act in the
 * workspace, then records the decision here. Row-level security is the backstop underneath.
 */
@Injectable()
export class WorkspaceContext {
    private readonly storage = new AsyncLocalStorage<WorkspaceRunContext>();

    run<T>(context: WorkspaceRunContext, fn: () => T): T {
        return this.storage.run(context, fn);
    }

    /** The current context, or `undefined` outside any `run`. */
    get(): WorkspaceRunContext | undefined {
        return this.storage.getStore();
    }
}

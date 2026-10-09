import { useParams } from 'react-router';

/**
 * Route parameters, typed. `useParams` is untyped and a renamed segment passes the compiler while
 * every reader breaks; this is the one place a segment's name is spelled, and a missing value is
 * an error at the call site rather than `undefined` three components later.
 */
export const WORKSPACE_PARAM = 'workspaceId';

export function useWorkspaceId(): string {
    const value = useParams()[WORKSPACE_PARAM];
    if (!value) throw new Error(`route has no :${WORKSPACE_PARAM} segment`);
    return value;
}

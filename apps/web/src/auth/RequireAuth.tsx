import type { ReactNode } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router';
import { ApiError } from '../api/client';
import { useMe } from '../api/queries';
import { signInPath } from '../routes/paths';

export type AuthGate = { state: 'pending' } | { state: 'signed-in' } | { state: 'signed-out'; to: string };

/**
 * The one rule for "who is this": it asks the API who the person is; a 401 means signed out (sent to
 * sign-in with where they were), any other failure is thrown to the route's error boundary (an
 * outage is not a reason to sign someone out). `RequireAuth` and the workspace shell both read it,
 * so the rule is written once.
 */
export function useAuthGate(): AuthGate {
    const location = useLocation();
    const me = useMe();
    if (me.isPending) return { state: 'pending' };
    if (me.isError) {
        if (me.error instanceof ApiError && me.error.isUnauthorized) {
            return { state: 'signed-out', to: signInPath(location.pathname + location.search) };
        }
        throw me.error;
    }
    return { state: 'signed-in' };
}

/**
 * The boundary between signed-out and signed-in routes outside a workspace (the workspace list).
 * While the answer is pending nothing protected renders. Workspace routes are guarded by their shell
 * instead, which draws its frame at once and holds only the content area (P1-UI-10, FR-CRMS-UI-7).
 */
export function RequireAuth({ children, pending }: { children?: ReactNode; pending?: ReactNode }) {
    const gate = useAuthGate();
    if (gate.state === 'pending') return <>{pending ?? null}</>;
    if (gate.state === 'signed-out') return <Navigate to={gate.to} replace />;
    return <>{children ?? <Outlet />}</>;
}

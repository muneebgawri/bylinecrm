import type { ReactNode } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router';
import { ApiError } from '../api/client';
import { useMe } from '../api/queries';
import { signInPath } from '../routes/paths';

/**
 * The boundary between signed-out and signed-in routes. It asks the API who the person is; a 401
 * sends them to sign-in with where they were, any other failure is left to the route's error
 * boundary (an outage is not a reason to sign someone out). While the answer is pending nothing
 * protected renders.
 */
export function RequireAuth({ children, pending }: { children?: ReactNode; pending?: ReactNode }) {
    const location = useLocation();
    const me = useMe();

    if (me.isPending) return <>{pending ?? null}</>;
    if (me.isError) {
        if (me.error instanceof ApiError && me.error.isUnauthorized) {
            return <Navigate to={signInPath(location.pathname + location.search)} replace />;
        }
        throw me.error;
    }
    return <>{children ?? <Outlet />}</>;
}

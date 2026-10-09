import { Button, Skeleton } from '@bylinecrm/ui';
import { Navigate, useLocation } from 'react-router';
import { ApiError } from '../../api/client';
import { useMe } from '../../api/queries';
import { paths, returnToFrom } from '../paths';
import { AuthLayout } from './AuthLayout';

/**
 * Where a provider sends the browser after sign-in (the API has already set the session cookie
 * and redirected here). It asks `/me` once: a person → onward; a 401 → the provider did not
 * sign them in, so say so rather than loop.
 */
export function AuthCallback() {
    const location = useLocation();
    const me = useMe();
    if (me.isSuccess) return <Navigate to={returnToFrom(location.search)} replace />;
    const failed = me.isError;
    const unauthorized = me.error instanceof ApiError && me.error.isUnauthorized;
    return (
        <AuthLayout title={failed ? 'Sign-in did not complete' : 'Signing you in…'}>
            {failed ? (
                <div className="flex flex-col gap-4">
                    <p className="m-0 text-text-muted">
                        {unauthorized
                            ? 'The provider did not confirm your email address, so no session was started.'
                            : 'The server could not be reached to finish signing in.'}
                    </p>
                    <Button data-primary-action asChild variant="primary" shape="square">
                        <a href={paths.signIn}>Back to sign in</a>
                    </Button>
                </div>
            ) : (
                <div className="grid gap-2" aria-label="Checking your session">
                    <Skeleton className="h-5 w-3/4" />
                    <Skeleton className="h-5 w-1/2" />
                </div>
            )}
        </AuthLayout>
    );
}

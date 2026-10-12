import { LINK_TOKEN_PARAM } from '@bylinecrm/shared';
import { Button, LoadingRegion, Skeleton } from '@bylinecrm/ui';
import { Link, Navigate, useLocation, useNavigate } from 'react-router';
import { ApiError } from '../../api/client';
import { useLogout, useMe, useResendVerification, useVerifyEmail } from '../../api/queries';
import { paths } from '../paths';
import { AuthLayout } from './AuthLayout';

/**
 * `/verify-email` (#93). With `?token=` it is the page a mailed link opens: one button that spends
 * the link — never on load, because mail scanners and link previews open links too. Without a token
 * it is where a signed-in, unverified person is held: which address the link went to, a way to get
 * a new one, and a way out.
 */
export function VerifyEmail() {
    const token = new URLSearchParams(useLocation().search).get(LINK_TOKEN_PARAM);
    return token ? <SpendLink token={token} /> : <CheckInbox />;
}

function SpendLink({ token }: { token: string }) {
    const navigate = useNavigate();
    const verify = useVerifyEmail();
    const invalid = verify.error instanceof ApiError && verify.error.code === 'token.invalid';

    if (verify.isSuccess) {
        return (
            <AuthLayout title="Your email is verified">
                <div className="flex flex-col gap-4">
                    <p className="m-0 text-text-muted" role="status">
                        Thanks. You can use BylineCRM now.
                    </p>
                    <Button
                        data-primary-action
                        variant="primary"
                        shape="square"
                        className="w-full"
                        onClick={() => navigate(paths.workspaces, { replace: true })}
                    >
                        Continue
                    </Button>
                </div>
            </AuthLayout>
        );
    }

    return (
        <AuthLayout title="Verify your email address" subtitle="Confirm this is your address to finish setting up.">
            <div className="flex flex-col gap-4">
                {verify.isError && (
                    <p role="alert" className="m-0 rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">
                        {invalid
                            ? 'This link has expired or was already used. Sign in to get a new one.'
                            : 'Could not verify. Check your connection and try again.'}
                    </p>
                )}
                {invalid ? (
                    <Button data-primary-action asChild variant="primary" shape="square" className="w-full">
                        <Link to={paths.verifyEmail}>Get a new link</Link>
                    </Button>
                ) : (
                    <Button
                        data-primary-action
                        variant="primary"
                        shape="square"
                        className="w-full"
                        loading={verify.isPending}
                        onClick={() => verify.mutate(token)}
                    >
                        Verify my email
                    </Button>
                )}
            </div>
        </AuthLayout>
    );
}

function CheckInbox() {
    const navigate = useNavigate();
    const me = useMe();
    const resend = useResendVerification();
    const logout = useLogout();

    if (me.isError) {
        if (me.error instanceof ApiError && me.error.isUnauthorized) return <Navigate to={paths.signIn} replace />;
        throw me.error;
    }
    if (me.isSuccess && me.data.emailVerified) return <Navigate to={paths.workspaces} replace />;

    const limited = resend.error instanceof ApiError && resend.error.status === 429;
    return (
        <AuthLayout title="Check your inbox" subtitle="Verify your email address to start using BylineCRM.">
            <div className="flex flex-col gap-4">
                {me.isPending ? (
                    <LoadingRegion label="Loading" className="grid gap-2">
                        <Skeleton className="h-5 w-3/4" />
                    </LoadingRegion>
                ) : (
                    <p className="m-0 text-text-muted">
                        We sent a link to <strong className="font-medium text-text">{me.data.email}</strong>. Open it on
                        this or any device. It expires in 24 hours.
                    </p>
                )}
                <div aria-live="polite">
                    {resend.isSuccess && (
                        <p className="m-0 rounded-md bg-success-soft px-3 py-2 text-sm text-success">
                            A new link is on its way. Earlier links no longer work.
                        </p>
                    )}
                    {resend.isError && (
                        <p role="alert" className="m-0 rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">
                            {limited
                                ? 'Too many links sent. Wait a while and try again.'
                                : 'Could not send a new link. Check your connection and try again.'}
                        </p>
                    )}
                </div>
                <Button
                    data-primary-action
                    variant="primary"
                    shape="square"
                    className="w-full"
                    loading={resend.isPending}
                    onClick={() => resend.mutate()}
                >
                    Send a new link
                </Button>
                <Button
                    variant="ghost"
                    shape="square"
                    className="w-full"
                    loading={logout.isPending}
                    onClick={() =>
                        logout.mutate(undefined, { onSettled: () => navigate(paths.signIn, { replace: true }) })
                    }
                >
                    Sign out
                </Button>
            </div>
        </AuthLayout>
    );
}

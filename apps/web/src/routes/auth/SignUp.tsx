import { CSRF_COOKIE, MEMBER_INVITE_PARAM, SIGNUP_INVITE_PARAM } from '@bylinecrm/shared';
import { Button, Field, Input, Skeleton } from '@bylinecrm/ui';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import { ApiError, readCookie } from '../../api/client';
import {
    useAcceptInvite,
    useAcceptInviteSignup,
    useInvitePreview,
    useLogout,
    useMe,
    useProviders,
    useSignup,
} from '../../api/queries';
import { paths, signInPath } from '../paths';
import { AuthLayout } from './AuthLayout';
import { PASSWORD_HINT } from './password';
import { ProviderButtons } from './ProviderButtons';

const linkClass = 'font-medium text-text underline-offset-4 hover:underline';

/**
 * `/sign-up` is three pages by its query string (P0-14): `?invite=` accepts a workspace invitation
 * (in every sign-up mode), `?signup=` creates an account with a platform sign-up invitation, and no
 * token creates an account and a workspace — only where the server says sign-up is open.
 */
export function SignUp() {
    const [params] = useSearchParams();
    const memberToken = params.get(MEMBER_INVITE_PARAM);
    if (memberToken) return <AcceptInvitation token={memberToken} />;
    return <CreateAccount signupToken={params.get(SIGNUP_INVITE_PARAM)} />;
}

function CreateAccount({ signupToken }: { signupToken: string | null }) {
    const navigate = useNavigate();
    const providers = useProviders();
    const signup = useSignup();
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [workspaceName, setWorkspaceName] = useState('');

    const mode = providers.data?.signup;
    if (providers.isPending) return <Pending title="Create your workspace" />;
    if (mode === 'closed' || (mode === 'invite' && !signupToken) || providers.isError) {
        return (
            <AuthLayout title="Sign-ups are closed" subtitle="This server takes new accounts by invitation only.">
                <p className="m-0 mb-5 text-text-muted">
                    Ask your administrator for an invitation. The link they send you opens the page to join.
                </p>
                <Button data-primary-action asChild variant="primary" shape="square" className="w-full">
                    <Link to={paths.signIn}>Sign in</Link>
                </Button>
            </AuthLayout>
        );
    }

    const submit = (event: FormEvent) => {
        event.preventDefault();
        signup.mutate(
            { email, password, workspaceName, inviteToken: signupToken ?? undefined },
            { onSuccess: ({ workspace }) => navigate(paths.home(workspace.id), { replace: true }) },
        );
    };

    const failure = signup.error instanceof ApiError ? signup.error : null;
    const fieldError = (path: string) => failure?.fieldErrors.find((f) => f.path === path)?.message;
    const general =
        failure?.code === 'signup.invitation_required'
            ? 'This invitation is not valid for that email address, or it was already used or has expired.'
            : failure?.code === 'signup.closed'
              ? 'Sign-ups are closed on this server. Ask your administrator for an invitation.'
              : failure && failure.fieldErrors.length === 0
                ? failure.status === 400 || failure.status === 401
                    ? 'Could not create the account with those details.'
                    : failure.message
                : signup.isError && !failure
                  ? 'Could not reach the server. Check your connection and try again.'
                  : null;

    return (
        <AuthLayout title="Create your workspace" subtitle="A workspace is your team's CRM; you can add more later.">
            {!signupToken && <ProviderButtons />}
            <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
                <Field
                    label="Work email"
                    required
                    hint={signupToken ? 'The address your invitation was sent to.' : undefined}
                    error={fieldError('email')}
                >
                    <Input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
                </Field>
                <Field label="Password" required hint={PASSWORD_HINT} error={fieldError('password')}>
                    <Input
                        type="password"
                        autoComplete="new-password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                    />
                </Field>
                <Field label="Workspace name" required error={fieldError('workspaceName') ?? general}>
                    <Input
                        autoComplete="organization"
                        placeholder="Acme PR"
                        value={workspaceName}
                        onChange={(e) => setWorkspaceName(e.target.value)}
                    />
                </Field>
                <Button
                    data-primary-action
                    type="submit"
                    variant="primary"
                    shape="square"
                    loading={signup.isPending}
                    className="w-full"
                >
                    Create workspace
                </Button>
            </form>
            <AlreadyHaveAccount />
        </AuthLayout>
    );
}

/**
 * Joining a workspace from its invitation link. Someone signed in as the invited address joins
 * with one click; someone signed out creates their account from the invitation (which verifies
 * the address) or signs in first and comes back here.
 */
function AcceptInvitation({ token }: { token: string }) {
    const location = useLocation();
    const navigate = useNavigate();
    // Only ask who is signed in when a session cookie pair exists: asking while signed out is a 401,
    // and a 401 anywhere sends the person to sign-in — away from the invitation they came to accept.
    const maybeSignedIn = readCookie(CSRF_COOKIE) !== undefined;
    const me = useMe(maybeSignedIn);
    const preview = useInvitePreview(token);
    const accept = useAcceptInvite();
    const signup = useAcceptInviteSignup();
    const logout = useLogout();
    const [password, setPassword] = useState('');
    const here = location.pathname + location.search;

    if (preview.isPending || (maybeSignedIn && me.isPending)) return <Pending title="Join a workspace" />;
    if (preview.isError) {
        const status = preview.error instanceof ApiError ? preview.error.status : undefined;
        return (
            <AuthLayout title="This invitation cannot be used">
                <p className="m-0 text-text-muted">
                    {status === 410
                        ? 'It was already used, or it has expired. Ask whoever invited you for a new link.'
                        : status === 404
                          ? 'The link is not a valid invitation. Check that it was copied whole.'
                          : 'Could not check the invitation. Check your connection and try again.'}
                </p>
                <AlreadyHaveAccount />
            </AuthLayout>
        );
    }

    const { email, workspaceName } = preview.data;
    const title = `Join ${workspaceName}`;
    const subtitle = (
        <>
            This invitation is for <b className="font-medium text-text">{email}</b>.
        </>
    );
    const goHome = (workspace: { id: string }) => navigate(paths.home(workspace.id), { replace: true });

    const signedIn = me.data;
    if (signedIn) {
        if (signedIn.email !== email) {
            return (
                <AuthLayout title={title} subtitle={subtitle}>
                    <p className="m-0 mb-4 text-text-muted">
                        You are signed in as <b className="font-medium text-text">{signedIn.email}</b>. Sign out, then
                        open the link again to join as {email}.
                    </p>
                    <Button
                        data-primary-action
                        shape="square"
                        className="w-full"
                        loading={logout.isPending}
                        onClick={() => logout.mutate(undefined, { onSettled: () => window.location.reload() })}
                    >
                        Sign out
                    </Button>
                </AuthLayout>
            );
        }
        const refused = accept.error instanceof ApiError ? accept.error : null;
        return (
            <AuthLayout title={title} subtitle={subtitle}>
                {refused && (
                    <p role="alert" className="m-0 mb-4 rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">
                        {refused.status === 409
                            ? 'You are already a member of this workspace.'
                            : refused.status === 403
                              ? `Could not join: ${refused.message}.`
                              : refused.message}
                    </p>
                )}
                <Button
                    data-primary-action
                    variant="primary"
                    shape="square"
                    className="w-full"
                    loading={accept.isPending}
                    onClick={() => accept.mutate(token, { onSuccess: goHome })}
                >
                    Join {workspaceName}
                </Button>
            </AuthLayout>
        );
    }

    const failure = signup.error instanceof ApiError ? signup.error : null;
    const submit = (event: FormEvent) => {
        event.preventDefault();
        signup.mutate({ token, password }, { onSuccess: goHome });
    };
    return (
        <AuthLayout title={title} subtitle={subtitle}>
            <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
                <Field label="Email">
                    <Input type="email" autoComplete="username" value={email} readOnly />
                </Field>
                <Field
                    label="Choose a password"
                    required
                    hint={PASSWORD_HINT}
                    error={
                        failure?.status === 409 ? (
                            <>
                                You already have an account.{' '}
                                <Link to={signInPath(here)} className={linkClass}>
                                    Sign in to accept
                                </Link>
                                .
                            </>
                        ) : (
                            (failure?.fieldErrors.find((f) => f.path === 'password')?.message ??
                            (failure ? failure.message : signup.isError ? 'Could not reach the server.' : undefined))
                        )
                    }
                >
                    <Input
                        type="password"
                        autoComplete="new-password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                    />
                </Field>
                <Button
                    data-primary-action
                    type="submit"
                    variant="primary"
                    shape="square"
                    loading={signup.isPending}
                    className="w-full"
                >
                    Create account and join
                </Button>
            </form>
            <p className="m-0 mt-5 text-center text-[13px] text-text-muted">
                Already have an account?{' '}
                <Link to={signInPath(here)} className={linkClass}>
                    Sign in to accept
                </Link>
            </p>
        </AuthLayout>
    );
}

function AlreadyHaveAccount() {
    return (
        <p className="m-0 mt-5 text-center text-[13px] text-text-muted">
            Already have an account?{' '}
            <Link to={paths.signIn} className={linkClass}>
                Sign in
            </Link>
        </p>
    );
}

function Pending({ title }: { title: string }): ReactNode {
    return (
        <AuthLayout title={title}>
            <div className="grid gap-3" role="status" aria-label="Loading">
                <Skeleton className="h-10" />
                <Skeleton className="h-10" />
            </div>
        </AuthLayout>
    );
}

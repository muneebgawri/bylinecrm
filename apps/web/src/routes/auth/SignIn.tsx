import { SIGN_IN_ERROR_PARAM } from '@bylinecrm/shared';
import { Button, Field, Input, PasswordInput } from '@bylinecrm/ui';
import { useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { ApiError } from '../../api/client';
import { useLogin, useProviders } from '../../api/queries';
import { paths, returnToFrom } from '../paths';
import { AuthLayout, authLinkClass } from './AuthLayout';
import { ProviderButtons } from './ProviderButtons';
import { TwoFactorStep } from './TwoFactorStep';

export function SignIn() {
    const navigate = useNavigate();
    const location = useLocation();
    const login = useLogin();
    // "Create a workspace" only where sign-up is open (P0-14); until the answer arrives, nothing.
    const signupOpen = useProviders().data?.signup === 'open';
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    // A two-factor account answers the password with a challenge; the code finishes it (2FA-1).
    const [challenge, setChallenge] = useState<string | null>(null);
    const onward = () => navigate(returnToFrom(location.search), { replace: true });

    const submit = (event: FormEvent) => {
        event.preventDefault();
        login.mutate(
            { email, password },
            { onSuccess: (result) => (result.twoFactor ? setChallenge(result.twoFactor.challenge) : onward()) },
        );
    };

    // A provider sign-in the API refused comes back here with its code (P0-14).
    const refused = new URLSearchParams(location.search).get(SIGN_IN_ERROR_PARAM);
    const failure = login.error instanceof ApiError ? login.error : null;
    const message =
        failure?.status === 401 || failure?.status === 400
            ? 'That email and password do not match.'
            : failure?.status === 429
              ? 'Too many attempts. Wait a minute and try again.'
              : login.isError
                ? 'Could not sign in. Check your connection and try again.'
                : null;

    if (challenge) {
        return (
            <TwoFactorStep
                challenge={challenge}
                onSignedIn={onward}
                onBack={() => {
                    setChallenge(null);
                    setPassword('');
                    login.reset();
                }}
            />
        );
    }

    const aside = signupOpen ? (
        <>
            New here?{' '}
            <Link to={paths.signUp} className={authLinkClass}>
                Create a workspace
            </Link>
        </>
    ) : (
        'New here? Ask your administrator for an invitation.'
    );

    return (
        <AuthLayout title="Welcome back" subtitle="Sign in to your BylineCRM account." aside={aside}>
            {refused === 'signup.closed' && (
                <p role="alert" className="m-0 mb-4 rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">
                    This server does not take new accounts. Ask your administrator for an invitation.
                </p>
            )}
            <ProviderButtons />
            <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
                <Field label="Email" required>
                    <Input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
                </Field>
                <Field label="Password" required error={message}>
                    <PasswordInput
                        autoComplete="current-password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                    />
                </Field>
                <p className="m-0 -mt-2 text-right text-xs">
                    <Link
                        to={paths.forgotPassword}
                        className="inline-flex min-h-touch items-center font-medium text-accent underline-offset-4 hover:underline md:min-h-0"
                    >
                        Forgot your password?
                    </Link>
                </p>
                <Button
                    data-primary-action
                    type="submit"
                    variant="primary"
                    shape="square"
                    loading={login.isPending}
                    className="w-full"
                >
                    Sign in
                </Button>
            </form>
        </AuthLayout>
    );
}

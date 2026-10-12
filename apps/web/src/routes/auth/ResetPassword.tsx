import { LINK_TOKEN_PARAM } from '@bylinecrm/shared';
import { Button, Field, Input } from '@bylinecrm/ui';
import { useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { ApiError, fieldErrorAt } from '../../api/client';
import { useResetPassword } from '../../api/queries';
import { paths } from '../paths';
import { AuthLayout } from './AuthLayout';
import { PASSWORD_HINT } from './password';

/**
 * `/reset-password?token=…` (#93): the page a mailed reset link opens. A new password signs this
 * browser in and every other session out; an expired or used link says so and offers a new one.
 */
export function ResetPassword() {
    const navigate = useNavigate();
    const token = new URLSearchParams(useLocation().search).get(LINK_TOKEN_PARAM);
    const reset = useResetPassword();
    const [password, setPassword] = useState('');
    const [confirm, setConfirm] = useState('');
    const [mismatch, setMismatch] = useState(false);

    const failure = reset.error instanceof ApiError ? reset.error : null;
    const invalidLink = !token || failure?.code === 'token.invalid';

    const submit = (event: FormEvent) => {
        event.preventDefault();
        if (password !== confirm) {
            setMismatch(true);
            return;
        }
        setMismatch(false);
        reset.mutate(
            { token: token ?? '', password },
            { onSuccess: () => navigate(paths.workspaces, { replace: true }) },
        );
    };

    if (invalidLink) {
        return (
            <AuthLayout title="This link no longer works">
                <div className="flex flex-col gap-4">
                    <p role="alert" className="m-0 text-text-muted">
                        Reset links work once and expire after 30 minutes. Ask for a new one.
                    </p>
                    <Button data-primary-action asChild variant="primary" shape="square" className="w-full">
                        <Link to={paths.forgotPassword}>Send a new link</Link>
                    </Button>
                </div>
            </AuthLayout>
        );
    }

    const passwordError =
        fieldErrorAt(failure, 'password') ??
        (failure && failure.status !== 400 ? 'Could not save. Check your connection and try again.' : null);

    return (
        <AuthLayout title="Choose a new password" subtitle="Saving it signs you out on every other device.">
            <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
                <Field label="New password" required hint={PASSWORD_HINT} error={passwordError}>
                    <Input
                        type="password"
                        autoComplete="new-password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                    />
                </Field>
                <Field label="Confirm new password" required error={mismatch ? 'The passwords do not match.' : null}>
                    <Input
                        type="password"
                        autoComplete="new-password"
                        value={confirm}
                        onChange={(e) => setConfirm(e.target.value)}
                    />
                </Field>
                <Button
                    data-primary-action
                    type="submit"
                    variant="primary"
                    shape="square"
                    loading={reset.isPending}
                    className="w-full"
                >
                    Save and sign in
                </Button>
            </form>
        </AuthLayout>
    );
}

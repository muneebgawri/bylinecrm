import { Button, Field, Input } from '@bylinecrm/ui';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { ApiError } from '../../api/client';
import { useSignup } from '../../api/queries';
import { paths } from '../paths';
import { AuthLayout } from './AuthLayout';
import { ProviderButtons } from './ProviderButtons';

/** The API's password rule, mirrored for the hint only; the API decides. */
const PASSWORD_HINT = 'At least 12 characters.';

export function SignUp() {
    const navigate = useNavigate();
    const signup = useSignup();
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [workspaceName, setWorkspaceName] = useState('');

    const submit = (event: FormEvent) => {
        event.preventDefault();
        signup.mutate(
            { email, password, workspaceName },
            { onSuccess: ({ workspace }) => navigate(paths.home(workspace.id), { replace: true }) },
        );
    };

    const failure = signup.error instanceof ApiError ? signup.error : null;
    const fieldError = (path: string) => failure?.fieldErrors.find((f) => f.path === path)?.message;
    const general =
        failure && failure.fieldErrors.length === 0
            ? failure.status === 400 || failure.status === 401
                ? 'Could not create the account with those details.'
                : failure.message
            : signup.isError && !failure
              ? 'Could not reach the server. Check your connection and try again.'
              : null;

    return (
        <AuthLayout title="Create your workspace" subtitle="A workspace is your team's CRM; you can add more later.">
            <ProviderButtons />
            <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
                <Field label="Work email" required error={fieldError('email')}>
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
                <Button type="submit" variant="primary" shape="square" loading={signup.isPending} className="w-full">
                    Create workspace
                </Button>
            </form>
            <p className="m-0 mt-5 text-center text-[13px] text-text-muted">
                Already have an account?{' '}
                <Link to={paths.signIn} className="font-medium text-text underline-offset-4 hover:underline">
                    Sign in
                </Link>
            </p>
        </AuthLayout>
    );
}

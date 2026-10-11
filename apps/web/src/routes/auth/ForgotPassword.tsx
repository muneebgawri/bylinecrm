import { Button, Field, Input } from '@bylinecrm/ui';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { ApiError } from '../../api/client';
import { useForgotPassword } from '../../api/queries';
import { paths } from '../paths';
import { AuthLayout } from './AuthLayout';

/**
 * `/forgot-password` (#93): asks for a reset link. The answer is the same whether or not the address
 * has an account — the page says "if", and never more — so it cannot be used to find out who
 * has one.
 */
export function ForgotPassword() {
    const forgot = useForgotPassword();
    const [email, setEmail] = useState('');
    const [sentTo, setSentTo] = useState<string | null>(null);

    const submit = (event: FormEvent) => {
        event.preventDefault();
        const address = email.trim();
        forgot.mutate(address, { onSuccess: () => setSentTo(address) });
    };

    const failure = forgot.error instanceof ApiError ? forgot.error : null;
    const message =
        failure?.status === 400
            ? 'Enter an email address.'
            : failure?.status === 429
              ? 'Too many requests. Wait a while and try again.'
              : forgot.isError
                ? 'Could not send the link. Check your connection and try again.'
                : null;

    if (sentTo) {
        return (
            <AuthLayout title="Check your inbox">
                <div className="flex flex-col gap-4">
                    <p className="m-0 text-text-muted" role="status">
                        If an account uses <strong className="font-medium text-text">{sentTo}</strong>, we sent it a
                        link to choose a new password. The link expires in 30 minutes.
                    </p>
                    <Button data-primary-action asChild variant="primary" shape="square" className="w-full">
                        <Link to={paths.signIn}>Back to sign in</Link>
                    </Button>
                </div>
            </AuthLayout>
        );
    }

    return (
        <AuthLayout title="Reset your password" subtitle="We will email you a link to choose a new one.">
            <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
                <Field label="Email" required error={message}>
                    <Input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
                </Field>
                <Button
                    data-primary-action
                    type="submit"
                    variant="primary"
                    shape="square"
                    loading={forgot.isPending}
                    className="w-full"
                >
                    Send reset link
                </Button>
            </form>
            <p className="m-0 mt-5 text-center text-[13px] text-text-muted">
                Remembered it?{' '}
                <Link to={paths.signIn} className="font-medium text-text underline-offset-4 hover:underline">
                    Sign in
                </Link>
            </p>
        </AuthLayout>
    );
}

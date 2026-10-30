import { Button, Field, Input } from '@bylinecrm/ui';
import { ShieldCheck } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { ApiError } from '../../api/client';
import { useLoginTwoFactor } from '../../api/queries';
import { AuthLayout } from './AuthLayout';

/**
 * The second half of a sign-in whose account has two-factor on (2FA-1): the six digits the
 * authenticator app shows, or one of the recovery codes kept from setup. The challenge lives in
 * memory only; a reload starts over at the password.
 */
export function TwoFactorStep({
    challenge,
    onSignedIn,
    onBack,
}: {
    challenge: string;
    onSignedIn: () => void;
    onBack: () => void;
}) {
    const verify = useLoginTwoFactor();
    const [code, setCode] = useState('');
    const [recovery, setRecovery] = useState(false);

    const submit = (event: FormEvent) => {
        event.preventDefault();
        verify.mutate({ challenge, code }, { onSuccess: onSignedIn });
    };

    const failure = verify.error instanceof ApiError ? verify.error : null;
    const expired = failure?.code === 'token.invalid';
    const message =
        failure?.code === 'two_factor.code_invalid'
            ? recovery
                ? 'That recovery code is not right, or was already used.'
                : 'That code is not right. Enter the next one your app shows.'
            : expired
              ? 'This sign-in has expired. Enter your password again.'
              : verify.isError
                ? 'Could not check the code. Check your connection and try again.'
                : null;

    return (
        <AuthLayout
            title="Enter your code"
            subtitle={
                recovery
                    ? 'One of the recovery codes you saved when you set up two-factor.'
                    : 'The six digits your authenticator app shows for BylineCRM.'
            }
            icon={<ShieldCheck />}
            hero={{
                eyebrow: 'One more step',
                heading: (
                    <>
                        Your account, <span className="text-accent">twice protected.</span>
                    </>
                ),
                body: 'A password alone is not enough here. Open your authenticator app and enter the code it shows now; it changes every thirty seconds.',
            }}
            aside={
                <button type="button" onClick={onBack} className="font-medium text-text underline underline-offset-4">
                    Use another account
                </button>
            }
        >
            <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
                <Field label={recovery ? 'Recovery code' : 'Authentication code'} required error={message}>
                    <Input
                        autoFocus
                        inputMode={recovery ? 'text' : 'numeric'}
                        autoComplete="one-time-code"
                        placeholder={recovery ? 'xxxxx-xxxxx' : '123 456'}
                        value={code}
                        onChange={(e) => setCode(e.target.value)}
                        className="text-center text-lg tracking-[0.3em] placeholder:tracking-normal"
                    />
                </Field>
                {expired ? (
                    <Button data-primary-action type="button" variant="primary" className="w-full" onClick={onBack}>
                        Back to sign in
                    </Button>
                ) : (
                    <Button
                        data-primary-action
                        type="submit"
                        variant="primary"
                        className="w-full"
                        loading={verify.isPending}
                    >
                        Verify
                    </Button>
                )}
                <p className="m-0 text-center text-xs text-text-muted">
                    {recovery ? 'Have your app back? ' : 'Lost your app? '}
                    <button
                        type="button"
                        onClick={() => {
                            setRecovery((r) => !r);
                            setCode('');
                            verify.reset();
                        }}
                        className="font-medium text-text underline underline-offset-4"
                    >
                        {recovery ? 'Use the authenticator code' : 'Use a recovery code'}
                    </button>
                </p>
            </form>
        </AuthLayout>
    );
}

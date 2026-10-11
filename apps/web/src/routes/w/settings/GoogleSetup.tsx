import { GMAIL_BROAD_SCOPE, type OAuthCheckOutcome } from '@bylinecrm/shared';
import { Badge, Button, Field, Input, Skeleton, toast } from '@bylinecrm/ui';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router';
import { fieldErrorAt } from '../../../api/client';
import {
    useOAuthClient,
    useOAuthClientStatus,
    usePutOAuthClient,
    useRemoveOAuthClient,
    useVerifyOAuthClient,
} from '../../../api/mailAdmin';
import type { GoogleOAuthClientCheckView, GoogleOAuthClientView } from '../../../api/types';
import { useCan } from '../../../auth/capabilities';
import { ConfirmDialog } from '../../../components/ConfirmDialog';
import { CopyValue } from '../../../components/CopyValue';
import { GoogleStatus } from '../../../components/GoogleStatus';
import { failureText } from '../../../lib/errors';
import { formatDate } from '../../../lib/format';
import { useWorkspaceId } from '../../params';
import { paths } from '../../paths';

/**
 * Google setup (doc 50 §E, FR-CRMS-1, D-237): the workspace's own OAuth client, in four steps an
 * admin follows in Google Cloud and here. A member who is not an admin sees only whether it is set
 * up. The API is the gate; this page decides what to offer.
 */
export function GoogleSetup() {
    const workspaceId = useWorkspaceId();
    const admin = useCan('workspace:admin');
    return (
        <section aria-labelledby="google-setup-title" className="max-w-3xl">
            <h2 id="google-setup-title" className="m-0 mb-1 text-base font-semibold">
                Google
            </h2>
            <p className="m-0 mb-5 text-[13px] text-text-muted">
                Mail is read and sent through this workspace’s own Google OAuth client. Nothing is shared with other
                workspaces, and the app only ever asks Google for send and read access.
            </p>
            {admin ? <AdminSetup workspaceId={workspaceId} /> : <MemberStatus workspaceId={workspaceId} />}
        </section>
    );
}

function MemberStatus({ workspaceId }: { workspaceId: string }) {
    const status = useOAuthClientStatus(workspaceId);
    if (status.isError) throw status.error;
    if (!status.data) return <Skeleton aria-busy="true" aria-label="Loading Google status" className="h-10" />;
    return <GoogleStatus workspaceId={workspaceId} status={status.data} />;
}

function AdminSetup({ workspaceId }: { workspaceId: string }) {
    const client = useOAuthClient(workspaceId);
    if (client.isError) throw client.error;
    if (!client.data) {
        return (
            <div aria-busy="true" aria-label="Loading Google setup" className="flex flex-col gap-4">
                <Skeleton className="h-40" />
                <Skeleton className="h-24" />
            </div>
        );
    }
    const view = client.data;
    return (
        <ol className="m-0 flex list-none flex-col gap-4 p-0">
            <Step number={1} title="Create an OAuth client in Google Cloud">
                <ul className="m-0 flex list-disc flex-col gap-2 pl-5 text-[13px]">
                    <li>Turn on the Gmail API in your Google Cloud project.</li>
                    <li>
                        Set the OAuth consent screen’s user type to <strong>Internal</strong>, so only your
                        organisation’s accounts can connect and Google needs no app review.
                    </li>
                    <li>
                        Add exactly these scopes to the consent screen:
                        <ul className="mt-1 flex list-none flex-col gap-1 p-0">
                            {view.scopes.map((scope) => (
                                <li key={scope}>
                                    <code className="text-xs break-all">{scope}</code>
                                </li>
                            ))}
                        </ul>
                    </li>
                    <li>
                        Never add <code className="text-xs break-all">{GMAIL_BROAD_SCOPE}</code> — a connection that
                        grants full mailbox access is refused.
                    </li>
                    <li>
                        Create an OAuth client of type Web application, with this as its only authorized redirect URI:
                    </li>
                </ul>
                <div className="mt-3">
                    <CopyValue value={view.redirectUri} label="Copy redirect URI" />
                </div>
            </Step>
            <Step number={2} title="Enter the client">
                <ClientCredentials workspaceId={workspaceId} view={view} />
            </Step>
            <Step number={3} title="Verify">
                <Verify workspaceId={workspaceId} view={view} />
            </Step>
            <Step number={4} title="Connect mailboxes">
                <p className="m-0 text-[13px] text-text-muted">
                    Each member connects their own mailbox, and admins connect shared outreach mailboxes, on the{' '}
                    <Link className="font-medium text-text underline" to={paths.mailboxes(workspaceId)}>
                        Mailboxes
                    </Link>{' '}
                    page.
                    {view.liveMailboxes > 0 &&
                        ` ${view.liveMailboxes} ${view.liveMailboxes === 1 ? 'mailbox uses' : 'mailboxes use'} this client.`}
                </p>
            </Step>
        </ol>
    );
}

function Step({ number, title, children }: { number: number; title: string; children: ReactNode }) {
    return (
        <li className="rounded-lg border border-border bg-surface p-4 shadow-sm">
            <h3 className="m-0 mb-3 flex items-center gap-2 text-sm font-semibold">
                <span
                    aria-hidden
                    className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-xs text-accent"
                >
                    {number}
                </span>
                <span>
                    <span className="sr-only">Step {number}: </span>
                    {title}
                </span>
            </h3>
            {children}
        </li>
    );
}

/** The client ID and secret. The secret is write-only: after saving, only its last four characters show. */
function ClientCredentials({ workspaceId, view }: { workspaceId: string; view: GoogleOAuthClientView }) {
    const [editing, setEditing] = useState(!view.configured);
    const [removing, setRemoving] = useState(false);
    const remove = useRemoveOAuthClient(workspaceId);
    if (editing) {
        return (
            <CredentialsForm
                workspaceId={workspaceId}
                initialClientId={view.clientId ?? ''}
                {...(view.configured ? { onCancel: () => setEditing(false) } : {})}
                onSaved={() => setEditing(false)}
            />
        );
    }
    return (
        <div className="flex flex-col gap-3">
            <dl className="m-0 grid gap-2 text-[13px] md:grid-cols-[8rem_1fr]">
                <dt className="text-text-muted">Client ID</dt>
                <dd className="m-0 break-all">
                    <code className="text-xs">{view.clientId}</code>
                </dd>
                <dt className="text-text-muted">Client secret</dt>
                <dd className="m-0">
                    <code className="text-xs">•••• {view.clientSecretLast4}</code>
                </dd>
            </dl>
            <div className="flex flex-wrap gap-2">
                <Button shape="square" size="sm" className="max-md:h-touch" onClick={() => setEditing(true)}>
                    Replace
                </Button>
                <Button
                    shape="square"
                    size="sm"
                    variant="ghost"
                    className="text-danger max-md:h-touch"
                    onClick={() => {
                        remove.reset();
                        setRemoving(true);
                    }}
                >
                    Remove client
                </Button>
            </div>
            <ConfirmDialog
                open={removing}
                onOpenChange={setRemoving}
                title="Remove the Google client?"
                body="Mailboxes can no longer connect until a client is set up again. A client still used by connected mailboxes cannot be removed."
                confirm="Remove client"
                pending={remove.isPending}
                error={remove.isError ? failureText(remove.error) : undefined}
                onConfirm={() =>
                    remove.mutate(undefined, {
                        onSuccess: () => {
                            setRemoving(false);
                            toast({ title: 'Google client removed' });
                        },
                    })
                }
            />
        </div>
    );
}

function CredentialsForm({
    workspaceId,
    initialClientId,
    onCancel,
    onSaved,
}: {
    workspaceId: string;
    initialClientId: string;
    onCancel?: () => void;
    onSaved: () => void;
}) {
    const put = usePutOAuthClient(workspaceId);
    const [clientId, setClientId] = useState(initialClientId);
    const [clientSecret, setClientSecret] = useState('');
    const submit = (event: FormEvent) => {
        event.preventDefault();
        put.mutate(
            { clientId: clientId.trim(), clientSecret },
            {
                onSuccess: () => {
                    // The secret leaves the page's memory once it is saved; only its last four come back.
                    setClientSecret('');
                    toast({ title: 'Google client saved', description: 'Verify it, then connect a mailbox.' });
                    onSaved();
                },
            },
        );
    };
    const generalError =
        put.isError && !fieldErrorAt(put.error, 'clientId') && !fieldErrorAt(put.error, 'clientSecret')
            ? failureText(put.error)
            : undefined;
    return (
        <form onSubmit={submit} noValidate className="flex flex-col gap-4">
            <Field
                label="Client ID"
                required
                hint="Ends in .apps.googleusercontent.com"
                error={fieldErrorAt(put.error, 'clientId')}
            >
                <Input
                    value={clientId}
                    onChange={(e) => setClientId(e.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                />
            </Field>
            <Field
                label="Client secret"
                required
                hint="Stored encrypted; afterwards only its last four characters are shown."
                error={fieldErrorAt(put.error, 'clientSecret')}
            >
                <Input
                    type="password"
                    value={clientSecret}
                    onChange={(e) => setClientSecret(e.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                />
            </Field>
            {generalError && (
                <p role="alert" className="m-0 rounded-md bg-danger-soft px-3 py-2 text-[13px] text-danger">
                    {generalError}
                </p>
            )}
            <div className="flex gap-2">
                {onCancel && (
                    <Button type="button" shape="square" onClick={onCancel}>
                        Cancel
                    </Button>
                )}
                <Button
                    type="submit"
                    variant="primary"
                    shape="square"
                    data-primary-action
                    loading={put.isPending}
                    disabled={!clientId.trim() || !clientSecret}
                >
                    Save client
                </Button>
            </div>
        </form>
    );
}

const OUTCOME: Record<OAuthCheckOutcome, { label: string; status: 'success' | 'danger' | 'neutral' }> = {
    pass: { label: 'Passed', status: 'success' },
    fail: { label: 'Failed', status: 'danger' },
    unverified: { label: 'Not yet confirmed', status: 'neutral' },
};

const CHECK_STEPS: readonly { key: keyof Omit<GoogleOAuthClientCheckView, 'checkedAt'>; label: string }[] = [
    { key: 'format', label: 'Client ID format' },
    { key: 'credentials', label: 'Client ID and secret' },
    { key: 'redirectUri', label: 'Redirect URI' },
];

function Verify({ workspaceId, view }: { workspaceId: string; view: GoogleOAuthClientView }) {
    const verify = useVerifyOAuthClient(workspaceId);
    const check = view.lastCheck;
    return (
        <div className="flex flex-col gap-3">
            <p className="m-0 text-[13px] text-text-muted">
                Checks what can be checked before anyone signs in. Google confirms the redirect URI only when someone
                signs in, so it is confirmed when the first mailbox connects.
            </p>
            {view.verifiedAt && (
                <p className="m-0 text-[13px]">
                    <Badge status="success" dot>
                        Confirmed
                    </Badge>{' '}
                    A mailbox connected through this client on {formatDate(view.verifiedAt)}.
                </p>
            )}
            {check && (
                <ul aria-label="Verification results" className="m-0 flex list-none flex-col gap-2 p-0">
                    {CHECK_STEPS.map(({ key, label }) => {
                        const step = check[key];
                        const outcome = OUTCOME[step.outcome];
                        return (
                            <li
                                key={key}
                                className="grid gap-1 rounded-md border border-border px-3 py-2 text-[13px] md:grid-cols-[11rem_auto_1fr] md:items-center md:gap-3"
                            >
                                <span className="font-medium">{label}</span>
                                <span>
                                    <Badge status={outcome.status}>{outcome.label}</Badge>
                                </span>
                                <span className="text-text-muted">{step.message}</span>
                            </li>
                        );
                    })}
                </ul>
            )}
            {verify.isError && (
                <p role="alert" className="m-0 rounded-md bg-danger-soft px-3 py-2 text-[13px] text-danger">
                    {failureText(verify.error)}
                </p>
            )}
            <div>
                <Button
                    shape="square"
                    size="sm"
                    className="max-md:h-touch"
                    loading={verify.isPending}
                    disabled={!view.configured}
                    onClick={() => verify.mutate()}
                >
                    Verify
                </Button>
            </div>
        </div>
    );
}

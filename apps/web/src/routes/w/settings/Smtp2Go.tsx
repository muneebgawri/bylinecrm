import { Badge, Button, Field, Input, LoadingRegion, toast } from '@bylinecrm/ui';
import { useState, type FormEvent } from 'react';
import { ApiError, fieldErrorAt } from '../../../api/client';
import {
    useAddSmtp2GoMailbox,
    usePutSmtp2GoKey,
    useRotateSmtp2GoSecret,
    useSmtp2GoMailboxes,
} from '../../../api/smtp2go';
import type { Smtp2GoMailboxView } from '../../../api/types';
import { ConfirmDialog } from '../../../components/ConfirmDialog';
import { CopyValue } from '../../../components/CopyValue';
import { failureText } from '../../../lib/errors';
import { formatWhen } from '../../../lib/format';
import { useWorkspaceId } from '../../params';
import { SETTINGS_SECTION_TITLE_ID } from './sectionTitle';

/** An SMTP2Go API key as SMTP2Go issues them (the API checks it too). */
const API_KEY = /^api-[A-Za-z0-9]{16,64}$/;

const RESULT_TEXT: Record<string, string> = {
    recorded: 'A bounce, complaint, open or click was recorded.',
    duplicate: 'A delivery already recorded arrived again.',
    unmatched: 'An event arrived for no send of this mailbox.',
    ignored: 'An event the CRM does not read was acknowledged.',
    bad_secret: 'A delivery was refused: its Authorization header did not match.',
};

/**
 * SMTP2Go (TRANS-1): pool mailboxes whose outreach leaves through SMTP2Go instead of Gmail. Only the sending pool —
 * personal and 1:1 mail always go from the member's own Gmail. Each mailbox has a webhook SMTP2Go reports bounces,
 * spam complaints, opens and clicks to; replies still arrive in the mailbox the message's Reply-To names.
 */
export function Smtp2Go() {
    const workspaceId = useWorkspaceId();
    const mailboxes = useSmtp2GoMailboxes(workspaceId);
    if (mailboxes.isError) throw mailboxes.error;
    return (
        <section aria-labelledby={SETTINGS_SECTION_TITLE_ID} className="max-w-3xl">
            <p className="m-0 mb-5 max-w-[70ch] text-[13px] text-text-muted">
                A pool mailbox can send its sequences through SMTP2Go instead of Gmail, from a domain SMTP2Go signs for.
                It is gated, warmed up and paused like any pool mailbox. Personal and 1:1 mail never go through SMTP2Go.
            </p>
            {mailboxes.data ? (
                <div className="flex flex-col gap-5">
                    {mailboxes.data.map((m) => (
                        <MailboxCard key={m.mailbox.id} workspaceId={workspaceId} view={m} />
                    ))}
                    <AddForm workspaceId={workspaceId} />
                </div>
            ) : (
                <LoadingRegion label="Loading SMTP2Go mailboxes" className="h-24" />
            )}
        </section>
    );
}

function AddForm({ workspaceId }: { workspaceId: string }) {
    const add = useAddSmtp2GoMailbox(workspaceId);
    const [email, setEmail] = useState('');
    const [apiKey, setApiKey] = useState('');
    const [dkimSelector, setDkimSelector] = useState('');
    const [local, setLocal] = useState<{ email?: string; apiKey?: string }>({});

    const submit = (event: FormEvent) => {
        event.preventDefault();
        const errors: { email?: string; apiKey?: string } = {};
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) errors.email = 'Enter the address the pool sends from.';
        if (!API_KEY.test(apiKey.trim())) errors.apiKey = 'Enter an SMTP2Go API key (api-…).';
        setLocal(errors);
        if (errors.email || errors.apiKey) return;
        add.mutate(
            {
                email: email.trim(),
                apiKey: apiKey.trim(),
                ...(dkimSelector.trim() ? { dkimSelector: dkimSelector.trim() } : {}),
            },
            {
                onSuccess: () => {
                    setEmail('');
                    setApiKey('');
                    setDkimSelector('');
                    toast({ title: 'SMTP2Go mailbox added' });
                },
                onError: (e) => {
                    if (!(e instanceof ApiError) || e.fieldErrors.length === 0) {
                        toast({ title: 'The mailbox was not added', description: failureText(e), tone: 'danger' });
                    }
                },
            },
        );
    };

    return (
        <form
            onSubmit={submit}
            noValidate
            aria-label="Add an SMTP2Go pool mailbox"
            className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-4"
        >
            <h3 className="m-0 text-[14px] font-semibold text-text">Add a pool mailbox</h3>
            <Field
                label="Sending address"
                hint="On a domain verified in SMTP2Go"
                error={local.email ?? fieldErrorAt(add.error, 'email')}
            >
                <Input
                    type="email"
                    autoComplete="off"
                    spellCheck={false}
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="max-w-[28rem]"
                />
            </Field>
            <Field
                label="API key"
                hint="An SMTP2Go API key allowed to send. Stored encrypted; never shown again."
                error={local.apiKey ?? fieldErrorAt(add.error, 'apiKey')}
            >
                <Input
                    type="password"
                    autoComplete="new-password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    className="max-w-[28rem]"
                />
            </Field>
            <Field
                label="DKIM selector"
                hint="Optional: the selector SMTP2Go gave the domain (s123456), for the domain check."
                error={fieldErrorAt(add.error, 'dkimSelector')}
            >
                <Input
                    autoComplete="off"
                    spellCheck={false}
                    value={dkimSelector}
                    onChange={(e) => setDkimSelector(e.target.value)}
                    className="max-w-[16rem]"
                />
            </Field>
            <div>
                <Button type="submit" variant="primary" shape="square" loading={add.isPending}>
                    Add mailbox
                </Button>
            </div>
        </form>
    );
}

function MailboxCard({ workspaceId, view }: { workspaceId: string; view: Smtp2GoMailboxView }) {
    const putKey = usePutSmtp2GoKey(workspaceId);
    const rotate = useRotateSmtp2GoSecret(workspaceId);
    const [apiKey, setApiKey] = useState('');
    const [keyError, setKeyError] = useState<string | undefined>();
    const [confirm, setConfirm] = useState(false);
    const { mailbox } = view;
    const disconnected = mailbox.status === 'disconnected';

    const saveKey = (event: FormEvent) => {
        event.preventDefault();
        if (!API_KEY.test(apiKey.trim())) return setKeyError('Enter an SMTP2Go API key (api-…).');
        setKeyError(undefined);
        putKey.mutate(
            { mailboxId: mailbox.id, apiKey: apiKey.trim() },
            {
                onSuccess: () => {
                    setApiKey('');
                    toast({ title: 'API key replaced' });
                },
                onError: (e) => toast({ title: 'The key was not saved', description: failureText(e), tone: 'danger' }),
            },
        );
    };

    return (
        <section
            aria-label={`SMTP2Go mailbox ${mailbox.email}`}
            className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4"
        >
            <div className="flex flex-wrap items-center gap-2">
                <h3 className="m-0 text-[14px] font-semibold break-all text-text">{mailbox.email}</h3>
                {disconnected ? (
                    <Badge status="neutral">Disconnected</Badge>
                ) : view.lastHookResult === 'bad_secret' ? (
                    <Badge status="danger">Webhook secret does not match</Badge>
                ) : view.lastHookAt ? (
                    <Badge status="success">Receiving events</Badge>
                ) : (
                    <Badge status="neutral">No events yet</Badge>
                )}
            </div>
            {disconnected ? (
                <p className="m-0 text-[13px] text-text-muted">
                    Its key and webhook secret were removed. Add it again below to send through it.
                </p>
            ) : (
                <>
                    <div className="flex flex-col gap-2 text-[13px]">
                        <p className="m-0">
                            In SMTP2Go (Settings › Webhooks), add this URL with the Authorization header below; include
                            the bounce, spam, open and click events, and the{' '}
                            <code className="text-xs">X-BylineCRM-Id</code> header.
                        </p>
                        <CopyValue value={view.hookUrl} label="Copy webhook URL" />
                        {view.hookAuthorization && (
                            <CopyValue value={view.hookAuthorization} label="Copy Authorization header value" />
                        )}
                    </div>
                    <p className="m-0 text-[13px] text-text-muted">
                        {view.lastHookAt
                            ? `${RESULT_TEXT[view.lastHookResult ?? ''] ?? 'An event arrived.'} Last event ${formatWhen(view.lastHookAt)}.`
                            : 'Bounces and complaints suppress the address and count towards the mailbox’s pause rates.'}
                    </p>
                    <form onSubmit={saveKey} noValidate className="flex flex-wrap items-end gap-2">
                        <Field label="Replace API key" error={keyError}>
                            <Input
                                type="password"
                                autoComplete="new-password"
                                value={apiKey}
                                onChange={(e) => setApiKey(e.target.value)}
                                className="max-w-[20rem]"
                            />
                        </Field>
                        <Button type="submit" variant="secondary" shape="square" loading={putKey.isPending}>
                            Save key
                        </Button>
                        <Button type="button" variant="ghost" shape="square" onClick={() => setConfirm(true)}>
                            New webhook secret
                        </Button>
                    </form>
                </>
            )}
            <ConfirmDialog
                open={confirm}
                onOpenChange={setConfirm}
                title="Make a new webhook secret?"
                body="SMTP2Go’s events are refused until you give it the new Authorization header."
                confirm="Make a new secret"
                pending={rotate.isPending}
                onConfirm={() =>
                    rotate.mutate(mailbox.id, {
                        onSuccess: () => {
                            setConfirm(false);
                            toast({ title: 'New webhook secret made' });
                        },
                        onError: (e) =>
                            toast({ title: 'That did not work', description: failureText(e), tone: 'danger' }),
                    })
                }
            />
        </section>
    );
}

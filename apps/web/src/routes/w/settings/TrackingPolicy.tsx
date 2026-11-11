import { Badge, Button, Field, Input, LoadingRegion, RadioGroup, Switch, toast } from '@bylinecrm/ui';
import { useId, useState, type FormEvent } from 'react';
import { ApiError, fieldErrorAt } from '../../../api/client';
import { useTrackingPolicy, useUpdateTrackingPolicy } from '../../../api/outreach';
import type { PatchTrackingPolicyInput, TrackingPolicyView } from '../../../api/types';
import { usePermission } from '../../../auth/capabilities';
import { failureText } from '../../../lib/errors';
import { formatWhen } from '../../../lib/format';

type Provider = TrackingPolicyView['provider'];

/**
 * TRACK-2: how the workspace tracks its mail — our own short links and pixel, or SMTP2Go's tracking (CRM-written mail
 * then goes through SMTP2Go, a copy kept in Gmail's Sent) — which of opens and clicks, whether email written in the
 * CRM is tracked by default, and reply notices for email sent straight from Gmail. An admin changes it; a switch
 * saves as it is flipped.
 */
export function TrackingPolicySection({ workspaceId }: { workspaceId: string }) {
    const policy = useTrackingPolicy(workspaceId);
    return (
        <section aria-labelledby="tracking-policy-title" className="flex flex-col gap-4">
            <h3 id="tracking-policy-title" className="m-0 text-[15px] font-semibold text-text">
                How email is tracked
            </h3>
            {policy.isError ? (
                <p role="alert" className="m-0 text-[13px] text-danger">
                    How email is tracked could not be loaded: {failureText(policy.error)}
                </p>
            ) : policy.data ? (
                <PolicyForm workspaceId={workspaceId} policy={policy.data} />
            ) : (
                <LoadingRegion label="Loading how email is tracked" className="h-24" />
            )}
        </section>
    );
}

function PolicyForm({ workspaceId, policy }: { workspaceId: string; policy: TrackingPolicyView }) {
    const edit = usePermission('workspace:admin');
    const update = useUpdateTrackingPolicy(workspaceId);
    const readOnly = !edit.allowed;
    const save = (input: PatchTrackingPolicyInput, done?: string) =>
        update.mutate(input, {
            onSuccess: () => done && toast({ title: done }),
            onError: (e) => {
                if (!(e instanceof ApiError) || e.fieldErrors.length === 0) {
                    toast({ title: 'Tracking was not changed', description: failureText(e), tone: 'danger' });
                }
            },
        });

    return (
        <div className="flex flex-col gap-5">
            {readOnly && (
                <p className="m-0 rounded-md bg-surface-raised px-3 py-2 text-[13px] text-text-muted">
                    {edit.reason} An admin changes how email is tracked.
                </p>
            )}
            <RadioGroup<Provider>
                legend="Tracking provider"
                value={policy.provider}
                disabled={readOnly || update.isPending}
                onValueChange={(provider) => save({ provider }, 'Tracking provider changed')}
                options={[
                    {
                        value: 'builtin',
                        label: 'Built in',
                        description:
                            'Our own short links and open pixel, on the short-link domain below. Email goes out through Gmail as before.',
                    },
                    {
                        value: 'smtp2go',
                        label: 'SMTP2Go',
                        description: policy.smtp2go.keySet
                            ? 'Tracked email written in the CRM goes through SMTP2Go, which tracks it; a copy is kept in the sender’s Gmail Sent. Sequence email from SMTP2Go pool mailboxes is tracked by SMTP2Go too.'
                            : 'Set the SMTP2Go API key below to choose it.',
                        disabled: !policy.smtp2go.keySet,
                    },
                ]}
            />
            <div className="flex flex-col gap-3">
                <Toggle
                    label="Track clicks"
                    note="Links are shortened, so a click is recorded on the person’s timeline and may move a deal by a stage rule."
                    on={policy.trackClicks}
                    disabled={readOnly || update.isPending}
                    onChange={(trackClicks) => save({ trackClicks })}
                />
                <Toggle
                    label="Track opens"
                    note="Only indicative: mail clients and scanners load images without anyone reading. Shown, never acted on."
                    on={policy.trackOpens}
                    disabled={readOnly || update.isPending}
                    onChange={(trackOpens) => save({ trackOpens })}
                />
                <Toggle
                    label="Track email written in the CRM by default"
                    note="Applies to email account managers write and send from the CRM. The writer can still switch it off for one email."
                    on={policy.trackPersonalMail}
                    disabled={readOnly || update.isPending}
                    onChange={(trackPersonalMail) => save({ trackPersonalMail })}
                />
                <Toggle
                    label="Tell members when a contact replies to email sent from Gmail"
                    note="Email sent straight from Gmail can’t be tracked, but a CRM contact’s reply to it shows in the sender’s notifications."
                    on={policy.gmailReplyNotices}
                    disabled={readOnly || update.isPending}
                    onChange={(gmailReplyNotices) => save({ gmailReplyNotices })}
                />
            </div>
            <Smtp2GoRelay workspaceId={workspaceId} policy={policy} readOnly={readOnly} />
        </div>
    );
}

function Toggle({
    label,
    note,
    on,
    disabled,
    onChange,
}: {
    label: string;
    note: string;
    on: boolean;
    disabled: boolean;
    onChange: (on: boolean) => void;
}) {
    const id = useId();
    const noteId = `${id}-note`;
    return (
        <div className="flex items-start gap-3">
            <Switch id={id} checked={on} disabled={disabled} onCheckedChange={onChange} aria-describedby={noteId} />
            <div className="flex min-w-0 flex-col gap-0.5">
                <label htmlFor={id} className="text-[13px] font-medium text-text">
                    {label}
                </label>
                <p id={noteId} className="m-0 text-[13px] text-text-muted">
                    {note}
                </p>
            </div>
        </div>
    );
}

/** The SMTP2Go key CRM-written mail goes through, the webhook to set up in SMTP2Go, and what it last delivered. */
function Smtp2GoRelay({
    workspaceId,
    policy,
    readOnly,
}: {
    workspaceId: string;
    policy: TrackingPolicyView;
    readOnly: boolean;
}) {
    const update = useUpdateTrackingPolicy(workspaceId);
    const [key, setKey] = useState('');
    const [local, setLocal] = useState<string | undefined>();
    const { smtp2go } = policy;

    const submit = (event: FormEvent) => {
        event.preventDefault();
        const value = key.trim();
        if (value === '') {
            setLocal('Paste the SMTP2Go API key.');
            return;
        }
        update.mutate(
            { smtp2goApiKey: value },
            {
                onSuccess: () => {
                    setKey('');
                    toast({
                        title: 'SMTP2Go key saved',
                        description: 'Set up the webhook in SMTP2Go with the URL and header shown.',
                    });
                },
                onError: (e) => {
                    if (!(e instanceof ApiError) || e.fieldErrors.length === 0) {
                        toast({ title: 'The key was not saved', description: failureText(e), tone: 'danger' });
                    }
                },
            },
        );
    };

    return (
        <section
            aria-labelledby="smtp2go-relay-title"
            className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4"
        >
            <div className="flex flex-wrap items-center gap-2">
                <h4 id="smtp2go-relay-title" className="m-0 text-[14px] font-semibold text-text">
                    SMTP2Go
                </h4>
                {smtp2go.keySet ? <Badge status="success">Key set</Badge> : <Badge status="neutral">No key</Badge>}
            </div>
            <p className="m-0 text-[13px] text-text-muted">
                The API key needs permission to send email. The sending domains (such as your account managers’ domain)
                must be verified in SMTP2Go, with its open and click tracking turned on.
            </p>
            {!readOnly && (
                <form onSubmit={submit} noValidate className="flex flex-wrap items-end gap-2">
                    <Field
                        label={smtp2go.keySet ? 'Replace API key' : 'API key'}
                        error={local ?? fieldErrorAt(update.error, 'smtp2goApiKey')}
                        className="min-w-[16rem] flex-1"
                    >
                        <Input
                            type="password"
                            autoComplete="off"
                            spellCheck={false}
                            placeholder={smtp2go.keySet ? 'A key is set' : 'api-…'}
                            value={key}
                            onChange={(e) => {
                                setKey(e.target.value);
                                setLocal(undefined);
                            }}
                        />
                    </Field>
                    <Button type="submit" variant="secondary" shape="square" loading={update.isPending}>
                        Save key
                    </Button>
                    {smtp2go.keySet && policy.provider !== 'smtp2go' && (
                        <Button
                            type="button"
                            variant="ghost"
                            shape="square"
                            onClick={() =>
                                update.mutate(
                                    { smtp2goApiKey: null },
                                    {
                                        onSuccess: () => toast({ title: 'SMTP2Go key removed' }),
                                        onError: (e) =>
                                            toast({
                                                title: 'The key was not removed',
                                                description: failureText(e),
                                                tone: 'danger',
                                            }),
                                    },
                                )
                            }
                        >
                            Remove key
                        </Button>
                    )}
                </form>
            )}
            {smtp2go.hookAuthorization && (
                <div className="flex flex-col gap-1">
                    <p className="m-0 text-[13px] font-medium text-text">Webhook to add in SMTP2Go</p>
                    <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[13px]">
                        <dt className="text-text-muted">URL</dt>
                        <dd className="m-0 break-all font-mono">{smtp2go.hookUrl}</dd>
                        <dt className="text-text-muted">Authorization header</dt>
                        <dd className="m-0 break-all font-mono">{smtp2go.hookAuthorization}</dd>
                        <dt className="text-text-muted">Events</dt>
                        <dd className="m-0">Open, click, bounce, spam, unsubscribe, reject and delivered</dd>
                    </dl>
                    <p className="m-0 text-[13px] text-text-muted">
                        {smtp2go.lastHookAt
                            ? `Last delivery ${formatWhen(smtp2go.lastHookAt)}: ${smtp2go.lastHookResult ?? 'unknown'}.`
                            : 'No delivery from SMTP2Go yet.'}
                    </p>
                </div>
            )}
            {policy.provider === 'smtp2go' && policy.mailboxesWithoutCopy.length > 0 && (
                <div role="status" className="rounded-md bg-surface-raised px-3 py-2 text-[13px] text-text">
                    <p className="m-0">
                        These mailboxes can’t keep a copy in Gmail’s Sent yet, so their tracked email still goes through
                        Gmail with built-in tracking. Connect them again — or, for mailboxes synced through the Google
                        Workspace service account, add the gmail.insert scope to its domain-wide delegation:
                    </p>
                    <ul className="m-0 mt-1 pl-5">
                        {policy.mailboxesWithoutCopy.map((m) => (
                            <li key={m.id} className="break-all">
                                {m.email}
                            </li>
                        ))}
                    </ul>
                </div>
            )}
        </section>
    );
}

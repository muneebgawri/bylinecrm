import type { DelegationMemberState } from '@bylinecrm/shared';
import { Badge, Button, Field, Input, LoadingRegion, Skeleton, Switch, toast } from '@bylinecrm/ui';
import { useState, type ChangeEvent, type FormEvent, type ReactNode } from 'react';
import { fieldErrorAt } from '../../../api/client';
import {
    useCheckDelegation,
    useDelegation,
    useDelegationAudit,
    useDelegationMembers,
    usePutDelegationKey,
    useRemoveDelegationKey,
    useSetDelegationMember,
    useUpdateDelegation,
} from '../../../api/mailAdmin';
import type { DelegationAuditEntryView, DelegationView } from '../../../api/types';
import { ConfirmDialog } from '../../../components/ConfirmDialog';
import { CopyValue } from '../../../components/CopyValue';
import { failureText } from '../../../lib/errors';
import { formatWhen } from '../../../lib/format';

/**
 * Google Workspace delegation (#225): one service account with domain-wide delegation syncs, and sends
 * from, every member in the allowed domains who has not connected their own mailbox. An admin's: the key
 * reads every member's mail. The setup steps live here, beside the fields they produce.
 */
export function WorkspaceDelegation({ workspaceId }: { workspaceId: string }) {
    const query = useDelegation(workspaceId);
    return (
        <section aria-labelledby="gws-delegation-title" className="mt-8">
            <h3 id="gws-delegation-title" className="m-0 mb-1 text-base font-semibold">
                Google Workspace delegation
            </h3>
            <p className="m-0 mb-4 text-[13px] text-text-muted">
                Instead of each member connecting their mailbox, one service account syncs every member’s Gmail and
                calendar, and sends their mail. Only members of this workspace whose address is in an allowed domain are
                synced — never other mailboxes in the domain. A member who connects their own mailbox uses that
                connection instead.
            </p>
            {query.isError ? (
                // The OAuth client above still works; this section says it failed rather than taking the page down.
                <p role="alert" className="m-0 rounded-md bg-danger-soft px-3 py-2 text-[13px] text-danger">
                    {failureText(query.error)}
                </p>
            ) : query.data ? (
                <DelegationSetup workspaceId={workspaceId} view={query.data} />
            ) : (
                <LoadingRegion label="Loading Workspace delegation">
                    <Skeleton className="h-40" />
                </LoadingRegion>
            )}
        </section>
    );
}

function DelegationSetup({ workspaceId, view }: { workspaceId: string; view: DelegationView }) {
    const scopeList = view.scopes.join(',');
    return (
        <ol className="m-0 flex list-none flex-col gap-4 p-0">
            <Step number={1} title="Create a service account in Google Cloud">
                <ul className="m-0 flex list-disc flex-col gap-2 pl-5 text-[13px]">
                    <li>
                        In the same Google Cloud project, make sure the Gmail API and the Google Calendar API are on.
                    </li>
                    <li>
                        Under IAM &amp; Admin → Service accounts, create a service account. It needs no project roles.
                    </li>
                    <li>On the service account’s Keys tab, add a key of type JSON and download it.</li>
                </ul>
            </Step>
            <Step number={2} title="Upload the key">
                <KeyUpload workspaceId={workspaceId} view={view} />
            </Step>
            <Step number={3} title="Authorise domain-wide delegation">
                <p className="m-0 mb-3 text-[13px] text-text-muted">
                    Your Google Workspace is managed through a reseller, so a super admin or your reseller adds this
                    entry: Admin console → Security → Access and data control → API controls → Manage Domain Wide
                    Delegation → Add new. Use exactly these values.
                </p>
                <dl className="m-0 grid gap-3 text-[13px]">
                    <div>
                        <dt className="mb-1 text-text-muted">Client ID</dt>
                        <dd className="m-0">
                            {view.clientId ? (
                                <CopyValue value={view.clientId} label="Copy client ID" />
                            ) : (
                                <span className="text-text-muted">Upload the key first.</span>
                            )}
                        </dd>
                    </div>
                    <div>
                        <dt className="mb-1 text-text-muted">OAuth scopes</dt>
                        <dd className="m-0 flex flex-col gap-2">
                            <ul aria-label="Scopes to authorise" className="m-0 flex list-none flex-col gap-1 p-0">
                                {view.scopes.map((scope) => (
                                    <li key={scope}>
                                        <code className="text-xs break-all">{scope}</code>
                                    </li>
                                ))}
                            </ul>
                            <CopyValue value={scopeList} label="Copy scopes" />
                        </dd>
                    </div>
                </dl>
            </Step>
            <Step number={4} title="Allowed domains">
                <Domains workspaceId={workspaceId} view={view} />
            </Step>
            <Step number={5} title="Check the connection">
                <Check workspaceId={workspaceId} view={view} />
            </Step>
            {view.configured && (
                <Step number={6} title="Members">
                    <Members workspaceId={workspaceId} />
                </Step>
            )}
            {view.configured && <Audit workspaceId={workspaceId} />}
        </ol>
    );
}

function Step({ number, title, children }: { number: number; title: string; children: ReactNode }) {
    return (
        <li className="rounded-lg border border-border bg-surface p-4 shadow-sm">
            <h4 className="m-0 mb-3 flex items-center gap-2 text-sm font-semibold">
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
            </h4>
            {children}
        </li>
    );
}

/** The key is write-only: once stored, only the account, its client ID and the key ID's last four show. */
function KeyUpload({ workspaceId, view }: { workspaceId: string; view: DelegationView }) {
    const put = usePutDelegationKey(workspaceId);
    const remove = useRemoveDelegationKey(workspaceId);
    const [removing, setRemoving] = useState(false);
    const onFile = async (event: ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (!file) return;
        put.mutate(await file.text(), {
            onSuccess: () =>
                toast({ title: 'Service account key saved', description: 'It was checked straight away.' }),
        });
    };
    return (
        <div className="flex flex-col gap-3">
            {view.configured && (
                <dl className="m-0 grid gap-2 text-[13px] md:grid-cols-[8rem_1fr]">
                    <dt className="text-text-muted">Service account</dt>
                    <dd className="m-0 break-all">
                        <code className="text-xs">{view.clientEmail}</code>
                    </dd>
                    <dt className="text-text-muted">Key</dt>
                    <dd className="m-0">
                        <code className="text-xs">•••• {view.privateKeyIdLast4}</code>
                    </dd>
                </dl>
            )}
            <Field
                label={view.configured ? 'Replace the JSON key' : 'JSON key'}
                hint="Stored encrypted and never shown again."
                error={put.isError ? (fieldErrorAt(put.error, 'key') ?? failureText(put.error)) : undefined}
            >
                <Input
                    type="file"
                    accept="application/json,.json"
                    onChange={(e) => void onFile(e)}
                    disabled={put.isPending}
                />
            </Field>
            {view.configured && (
                <div>
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
                        Remove key
                    </Button>
                </div>
            )}
            <ConfirmDialog
                open={removing}
                onOpenChange={setRemoving}
                title="Remove the service account key?"
                body="Every mailbox synced through Workspace delegation stops. Mail already synced stays on its records."
                confirm="Remove key"
                pending={remove.isPending}
                error={remove.isError ? failureText(remove.error) : undefined}
                onConfirm={() =>
                    remove.mutate(undefined, {
                        onSuccess: () => {
                            setRemoving(false);
                            toast({ title: 'Service account key removed' });
                        },
                    })
                }
            />
        </div>
    );
}

function Domains({ workspaceId, view }: { workspaceId: string; view: DelegationView }) {
    const update = useUpdateDelegation(workspaceId);
    const [text, setText] = useState(view.allowedDomains.join(', '));
    const submit = (event: FormEvent) => {
        event.preventDefault();
        const allowedDomains = text
            .split(/[\s,]+/)
            .map((d) => d.trim().replace(/^@/, ''))
            .filter(Boolean);
        update.mutate({ allowedDomains }, { onSuccess: () => toast({ title: 'Allowed domains saved' }) });
    };
    return (
        <form onSubmit={submit} noValidate className="flex flex-col gap-3">
            <Field
                label="Domains"
                hint="Comma-separated, e.g. pinionpartners.co, pinionnewswire.com. Members outside them connect their own mailbox."
                error={update.isError ? failureText(update.error) : undefined}
            >
                <Input
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    spellCheck={false}
                    disabled={!view.configured}
                />
            </Field>
            <div>
                <Button type="submit" shape="square" size="sm" loading={update.isPending} disabled={!view.configured}>
                    Save domains
                </Button>
            </div>
        </form>
    );
}

function Check({ workspaceId, view }: { workspaceId: string; view: DelegationView }) {
    const check = useCheckDelegation(workspaceId);
    const last = view.lastCheck;
    const missing = last ? last.scopes.filter((s) => !s.granted) : [];
    return (
        <div className="flex flex-col gap-3">
            <p className="m-0 text-[13px] text-text-muted">
                Asks Google for a token for your own address, once per scope, and reports which scopes the delegation
                entry authorises.
            </p>
            <p className="m-0 text-[13px]">
                {view.active ? (
                    <Badge status="success" dot>
                        Active — {view.delegatedMailboxes} {view.delegatedMailboxes === 1 ? 'mailbox' : 'mailboxes'}{' '}
                        synced
                    </Badge>
                ) : (
                    <Badge status="neutral">Not active</Badge>
                )}
            </p>
            {last && (
                <>
                    <ul aria-label="Check results" className="m-0 flex list-none flex-col gap-2 p-0">
                        {last.scopes.map((s) => (
                            <li
                                key={s.scope}
                                className="grid gap-1 rounded-md border border-border px-3 py-2 text-[13px] md:grid-cols-[1fr_auto] md:items-center md:gap-3"
                            >
                                <code className="text-xs break-all">{s.scope}</code>
                                <span>
                                    <Badge status={s.granted ? 'success' : 'danger'}>
                                        {s.granted ? 'Authorised' : `Missing${s.error ? ` (${s.error})` : ''}`}
                                    </Badge>
                                </span>
                            </li>
                        ))}
                    </ul>
                    <p className="m-0 text-xs text-text-muted">
                        Checked as {last.subject}, {formatWhen(last.checkedAt)}.
                        {missing.length > 0 &&
                            ` ${missing.length} of ${last.scopes.length} scopes missing: ask your reseller or super admin to add them to the delegation entry.`}
                    </p>
                </>
            )}
            {check.isError && (
                <p role="alert" className="m-0 rounded-md bg-danger-soft px-3 py-2 text-[13px] text-danger">
                    {failureText(check.error)}
                </p>
            )}
            <div>
                <Button
                    shape="square"
                    size="sm"
                    className="max-md:h-touch"
                    loading={check.isPending}
                    disabled={!view.configured}
                    onClick={() => check.mutate(undefined)}
                >
                    Check connection
                </Button>
            </div>
        </div>
    );
}

const STATE: Record<DelegationMemberState, { label: string; status: 'success' | 'neutral' | 'warning' | 'accent' }> = {
    delegated: { label: 'Synced via Workspace delegation', status: 'success' },
    own_connection: { label: 'Own connection', status: 'accent' },
    excluded: { label: 'Excluded', status: 'neutral' },
    outside_domains: { label: 'Outside allowed domains', status: 'neutral' },
};

function Members({ workspaceId }: { workspaceId: string }) {
    const members = useDelegationMembers(workspaceId);
    const set = useSetDelegationMember(workspaceId);
    if (members.isError) return <p className="m-0 text-[13px] text-danger">{failureText(members.error)}</p>;
    if (!members.data) return <Skeleton className="h-24" />;
    return (
        <ul aria-label="Members" className="m-0 flex list-none flex-col divide-y divide-border p-0">
            {members.data.map((m) => (
                <li key={m.memberId} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-[13px]">
                    <span className="min-w-0 flex-1">
                        <span className="font-medium">{m.name ?? m.email}</span>
                        {m.name && <span className="block truncate text-xs text-text-muted">{m.email}</span>}
                    </span>
                    <Badge status={STATE[m.state].status}>{STATE[m.state].label}</Badge>
                    <label className="inline-flex items-center gap-2 text-xs text-text-muted">
                        <Switch
                            checked={!m.excluded}
                            disabled={set.isPending}
                            aria-label={`Sync ${m.email} through delegation`}
                            onCheckedChange={(on) =>
                                set.mutate(
                                    { memberId: m.memberId, excluded: !on },
                                    { onError: (e) => toast({ title: failureText(e), tone: 'danger' }) },
                                )
                            }
                        />
                        Include
                    </label>
                </li>
            ))}
        </ul>
    );
}

const ACTION_LABEL: Record<DelegationAuditEntryView['action'], string> = {
    key_set: 'Key uploaded',
    key_removed: 'Key removed',
    domains_changed: 'Allowed domains changed',
    member_excluded: 'Member excluded',
    member_included: 'Member included',
    checked: 'Connection checked',
    mail_sync_started: 'Mail sync started',
    calendar_sync_started: 'Calendar sync started',
};

function Audit({ workspaceId }: { workspaceId: string }) {
    const audit = useDelegationAudit(workspaceId);
    if (!audit.data || audit.data.length === 0) return null;
    return (
        <li className="rounded-lg border border-border bg-surface p-4 shadow-sm">
            <h4 className="m-0 mb-3 text-sm font-semibold">Audit log</h4>
            <ul
                aria-label="Audit log"
                className="m-0 flex max-h-72 list-none flex-col gap-1 overflow-y-auto p-0 text-[13px]"
            >
                {audit.data.map((a) => (
                    <li key={a.id} className="flex flex-wrap gap-x-2">
                        <span className="text-text-muted">{formatWhen(a.createdAt)}</span>
                        <span>{ACTION_LABEL[a.action]}</span>
                        {typeof a.detail['email'] === 'string' && (
                            <span className="text-text-muted">{a.detail['email']}</span>
                        )}
                    </li>
                ))}
            </ul>
        </li>
    );
}

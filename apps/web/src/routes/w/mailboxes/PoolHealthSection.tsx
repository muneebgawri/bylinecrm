import { SENDING_POOL_LIMITS, type DomainCheck } from '@bylinecrm/shared';
import {
    Badge,
    Button,
    DataTableChrome,
    Dialog,
    DialogBody,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogTitle,
    DropdownMenuItem,
    EmptyState,
    Field,
    Input,
    Textarea,
    toast,
} from '@bylinecrm/ui';
import { useState, type FormEvent } from 'react';
import { fieldErrorAt } from '../../../api/client';
import {
    useCheckSendingDomain,
    useConnectPostmaster,
    useDisconnectPostmaster,
    useResumeMailbox,
    useSendingPool,
    useSetMailboxCap,
    useUpdatePoolSettings,
} from '../../../api/sendingPool';
import type {
    PoolMailboxHealthView,
    SendingDomainView,
    SendingPoolSettingsView,
    SendingPoolView,
} from '../../../api/types';
import { useCan } from '../../../auth/capabilities';
import { ConfirmDialog } from '../../../components/ConfirmDialog';
import { failureText } from '../../../lib/errors';
import { formatRelative } from '../../../lib/format';
import { leaveFor } from '../../../lib/leaveFor';
import { DOMAIN_STATUS, percentText, postmasterLine, STEP_LABEL } from './domainHealth';

/**
 * The sending pool's health (P3-2, FR-CRMS-6, FR-CRMS-13): for each pool mailbox, what it may still
 * send in the rolling 24 hours (its cap or warm-up day's limit), its sending domain's DNS check, and
 * why it is paused when it is. Admins resume a paused mailbox (with a note), set a mailbox's own cap,
 * check a domain again and change the pool's settings. Shown to people who may run outreach.
 */
export function PoolHealthSection({ workspaceId }: { workspaceId: string }) {
    const mayRead = useCan('outreach:write');
    const admin = useCan('workspace:admin');
    const pool = useSendingPool(workspaceId, mayRead);
    const check = useCheckSendingDomain(workspaceId);
    const [resuming, setResuming] = useState<PoolMailboxHealthView | null>(null);
    const [capping, setCapping] = useState<PoolMailboxHealthView | null>(null);
    const [editingSettings, setEditingSettings] = useState(false);
    if (!mayRead) return null;
    if (pool.isError) throw pool.error;

    const checkDomain = (domain: SendingDomainView) =>
        check.mutate(domain.id, {
            onSuccess: (result) =>
                toast({
                    title: result.status === 'pass' ? `${result.domain} is verified` : `${result.domain} still fails`,
                    tone: result.status === 'pass' ? 'success' : 'danger',
                }),
            onError: (error) =>
                toast({ title: 'The check did not run', description: failureText(error), tone: 'danger' }),
        });

    return (
        <section aria-labelledby="pool-title" className="mt-8">
            <h2 id="pool-title" className="m-0 mb-1 text-base font-semibold">
                Sending pool
            </h2>
            <p className="m-0 mb-3 max-w-[65ch] text-[13px] text-text-muted">
                Pool mailboxes send outreach. Each sends at most its allowance in any 24 hours, rising through warm-up
                to its cap, only from a domain that passes SPF, DKIM and DMARC, and pauses itself when bounces or
                complaints run high.
            </p>
            <DataTableChrome
                {...(admin &&
                    pool.data && {
                        toolbar: {
                            extra: (
                                <Button shape="square" size="sm" onClick={() => setEditingSettings(true)}>
                                    Pool settings
                                </Button>
                            ),
                        },
                    })}
                data={{
                    label: 'Sending pool',
                    loading: pool.isPending,
                    rows: pool.data?.mailboxes ?? [],
                    getRowId: (m) => m.mailboxId,
                    empty: (
                        <EmptyState
                            className="m-4"
                            title="No pool mailbox"
                            body="Connect a mailbox with the Pool purpose to send outreach from it."
                        />
                    ),
                    columns: [
                        {
                            id: 'mailbox',
                            header: 'Mailbox',
                            cell: (m) => (
                                <div className="min-w-0">
                                    <div className="truncate font-medium">{m.email}</div>
                                    {m.paused && (
                                        <p className="m-0 mt-0.5 text-xs text-danger" data-testid="pause-reason">
                                            Paused: {m.paused.message}
                                        </p>
                                    )}
                                </div>
                            ),
                        },
                        {
                            id: 'allowance',
                            header: 'Last 24 hours',
                            phone: 'meta',
                            cell: (m) => (
                                <span>
                                    {m.used} of {m.allowance}
                                    <span className="block text-xs text-text-muted">
                                        {m.warmupLimit < m.dailyCap && m.warmupDay !== null
                                            ? `Warm-up day ${m.warmupDay}, cap ${m.dailyCap}`
                                            : `Cap ${m.dailyCap}${m.dailyCapOverride !== null ? ' (its own)' : ''}`}
                                    </span>
                                </span>
                            ),
                        },
                        {
                            id: 'domain',
                            header: 'Sending domain',
                            phone: 'meta',
                            cell: (m) => <DomainCell domain={m.domain} />,
                        },
                        {
                            id: 'state',
                            header: 'State',
                            // On a phone the state sits under the address: it is what a glance is for.
                            phone: 'secondary',
                            cell: (m) =>
                                m.paused ? (
                                    <Badge status="danger">Paused</Badge>
                                ) : m.canSend ? (
                                    <Badge status="success">Sending</Badge>
                                ) : (
                                    <Badge status="neutral">Not sending</Badge>
                                ),
                        },
                    ],
                    ...(admin && {
                        rowActions: {
                            label: (m: PoolMailboxHealthView) => m.email,
                            items: (m: PoolMailboxHealthView) => (
                                <>
                                    {m.paused && (
                                        <DropdownMenuItem onSelect={() => setResuming(m)}>Resume…</DropdownMenuItem>
                                    )}
                                    <DropdownMenuItem onSelect={() => setCapping(m)}>Set its cap…</DropdownMenuItem>
                                    {m.domain && (
                                        <DropdownMenuItem onSelect={() => checkDomain(m.domain!)}>
                                            Check {m.domain.domain} again
                                        </DropdownMenuItem>
                                    )}
                                </>
                            ),
                        },
                    }),
                }}
            />
            {resuming && (
                <ResumeDialog workspaceId={workspaceId} mailbox={resuming} onClose={() => setResuming(null)} />
            )}
            {capping && <CapDialog workspaceId={workspaceId} mailbox={capping} onClose={() => setCapping(null)} />}
            {editingSettings && pool.data && (
                <SettingsDialog
                    workspaceId={workspaceId}
                    settings={pool.data.settings}
                    onClose={() => setEditingSettings(false)}
                />
            )}
            {pool.data && <PostmasterCard workspaceId={workspaceId} connection={pool.data.postmaster} admin={admin} />}
        </section>
    );
}

function DomainCell({ domain }: { domain: SendingDomainView | null }) {
    if (!domain) return <span className="text-text-muted">—</span>;
    const status = DOMAIN_STATUS[domain.status];
    const failing = domain.lastCheck
        ? (Object.keys(STEP_LABEL) as (keyof DomainCheck)[]).filter((k) => domain.lastCheck![k].outcome === 'fail')
        : [];
    return (
        <div className="min-w-0">
            <span className="mr-2 break-all">{domain.domain}</span>
            <Badge status={status.tone}>{status.label}</Badge>
            {failing.length > 0 && (
                <ul
                    className="m-0 mt-1 list-none p-0 text-xs text-text-muted"
                    aria-label={`${domain.domain} failing checks`}
                >
                    {failing.map((k) => (
                        <li key={k}>
                            {STEP_LABEL[k]}: {domain.lastCheck![k].message}
                        </li>
                    ))}
                </ul>
            )}
            {domain.spamRate && (
                <span className="block text-xs text-text-muted">
                    Spam rate {percentText(domain.spamRate.rateBps)} on {domain.spamRate.day}
                </span>
            )}
            {postmasterLine(domain.postmaster)}
            {domain.checkedAt && (
                <span className="block text-xs text-text-muted">Checked {formatRelative(domain.checkedAt)}</span>
            )}
        </div>
    );
}

/**
 * The Postmaster Tools account (#129): the one Google account that verified the pool's sending
 * domains there, connected through the workspace's OAuth client so each domain check can read its
 * user-reported spam rate. An admin connects it (the browser leaves for Google) or disconnects it;
 * everyone who reads the pool sees whose it is.
 */
function PostmasterCard({
    workspaceId,
    connection,
    admin,
}: {
    workspaceId: string;
    connection: SendingPoolView['postmaster'];
    admin: boolean;
}) {
    const connect = useConnectPostmaster(workspaceId);
    const disconnect = useDisconnectPostmaster(workspaceId);
    const [disconnecting, setDisconnecting] = useState(false);
    const start = () =>
        connect.mutate(undefined, {
            onSuccess: (started) => leaveFor(started.authorizeUrl),
            onError: (error) =>
                toast({ title: 'Could not start the connect', description: failureText(error), tone: 'danger' }),
        });
    return (
        <section
            aria-labelledby="postmaster-title"
            className="mt-4 flex flex-wrap items-start justify-between gap-3 rounded-md bg-surface-raised px-3 py-2"
        >
            <div className="min-w-0 max-w-[65ch] text-[13px]">
                <h3 id="postmaster-title" className="m-0 text-[13px] font-semibold">
                    Postmaster Tools
                </h3>
                {connection ? (
                    <p className="m-0 text-text-muted">
                        Connected as <span className="font-medium text-text">{connection.email}</span>
                        {connection.status === 'reconnect_needed' ? (
                            <span className="block text-warning">
                                Needs reconnecting: {connection.lastError ?? 'Google refused the stored access'}.
                            </span>
                        ) : (
                            <span className="block">
                                Each domain check reads the last 30 days of user-reported spam rates, for the account’s
                                own domains too; a pool domain at or past the complaint threshold pauses every pool
                                mailbox on it.
                            </span>
                        )}
                    </p>
                ) : (
                    <p className="m-0 text-text-muted">
                        Not connected. Connect the Google account that owns the sending domains in Postmaster Tools so
                        each check reads the domain’s spam rate as Google sees it
                        {admin ? '' : ' — an admin does this'}.
                    </p>
                )}
            </div>
            {admin && (
                <div className="flex gap-2">
                    {connection && (
                        <Button size="sm" shape="square" variant="ghost" onClick={() => setDisconnecting(true)}>
                            Disconnect
                        </Button>
                    )}
                    <Button size="sm" shape="square" onClick={start} disabled={connect.isPending}>
                        {connection ? 'Connect again' : 'Connect Postmaster Tools'}
                    </Button>
                </div>
            )}
            <ConfirmDialog
                open={disconnecting}
                onOpenChange={setDisconnecting}
                title="Disconnect Postmaster Tools?"
                body="The CRM gives up the account’s access and stops reading spam rates. Rates already read stay on the domains."
                confirm="Disconnect Postmaster Tools"
                pending={disconnect.isPending}
                error={disconnect.isError ? failureText(disconnect.error) : undefined}
                onConfirm={() =>
                    disconnect.mutate(undefined, {
                        onSuccess: () => {
                            toast({ title: 'Postmaster Tools disconnected', tone: 'success' });
                            setDisconnecting(false);
                        },
                    })
                }
            />
        </section>
    );
}

function ResumeDialog({
    workspaceId,
    mailbox,
    onClose,
}: {
    workspaceId: string;
    mailbox: PoolMailboxHealthView;
    onClose: () => void;
}) {
    const resume = useResumeMailbox(workspaceId);
    const [note, setNote] = useState('');
    const submit = (event: FormEvent) => {
        event.preventDefault();
        resume.mutate(
            { mailboxId: mailbox.mailboxId, note },
            {
                onSuccess: () => {
                    toast({ title: `${mailbox.email} is sending again`, tone: 'success' });
                    onClose();
                },
            },
        );
    };
    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent>
                <form onSubmit={submit} noValidate>
                    <DialogTitle>Resume {mailbox.email}?</DialogTitle>
                    <DialogDescription>
                        {mailbox.paused?.message}. Its history stays: the next bounce or complaint is judged against it
                        again, so fix the cause first.
                    </DialogDescription>
                    <DialogBody>
                        <Field
                            label="What changed"
                            required
                            error={
                                fieldErrorAt(resume.error, 'note') ??
                                (resume.error ? failureText(resume.error) : undefined)
                            }
                        >
                            <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} />
                        </Field>
                    </DialogBody>
                    <DialogFooter>
                        <Button type="button" variant="ghost" onClick={onClose}>
                            Cancel
                        </Button>
                        <Button type="submit" variant="primary" disabled={resume.isPending || note.trim() === ''}>
                            Resume
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

function CapDialog({
    workspaceId,
    mailbox,
    onClose,
}: {
    workspaceId: string;
    mailbox: PoolMailboxHealthView;
    onClose: () => void;
}) {
    const setCap = useSetMailboxCap(workspaceId);
    const [value, setValue] = useState(mailbox.dailyCapOverride?.toString() ?? '');
    const submit = (event: FormEvent) => {
        event.preventDefault();
        setCap.mutate(
            { mailboxId: mailbox.mailboxId, dailyCap: value.trim() === '' ? null : Number(value) },
            { onSuccess: onClose },
        );
    };
    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent>
                <form onSubmit={submit} noValidate>
                    <DialogTitle>Cap for {mailbox.email}</DialogTitle>
                    <DialogDescription>
                        The most it sends in any 24 hours once warmed up. Leave empty to use the pool&apos;s cap.
                    </DialogDescription>
                    <DialogBody>
                        <Field
                            label="Daily cap"
                            error={
                                fieldErrorAt(setCap.error, 'dailyCap') ??
                                (setCap.error ? failureText(setCap.error) : undefined)
                            }
                        >
                            <Input
                                type="number"
                                inputMode="numeric"
                                min={SENDING_POOL_LIMITS.dailyCap.min}
                                max={SENDING_POOL_LIMITS.dailyCap.max}
                                value={value}
                                onChange={(e) => setValue(e.target.value)}
                            />
                        </Field>
                    </DialogBody>
                    <DialogFooter>
                        <Button type="button" variant="ghost" onClick={onClose}>
                            Cancel
                        </Button>
                        <Button type="submit" variant="primary" disabled={setCap.isPending}>
                            Save
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

/** The pool's settings, each with what it does; rates are shown in percent and stored in basis points. */
const SETTING_FIELDS: { key: keyof SendingPoolSettingsView; label: string; hint: string; percent?: boolean }[] = [
    { key: 'dailyCap', label: 'Daily cap per mailbox', hint: 'Most a warmed-up mailbox sends in any 24 hours.' },
    { key: 'warmupStartPerDay', label: 'Warm-up: first day', hint: 'What a new mailbox sends on its first day.' },
    { key: 'warmupDays', label: 'Warm-up: days to full cap', hint: 'It rises evenly to the cap over these days.' },
    { key: 'jitterMinSeconds', label: 'Spacing: at least (seconds)', hint: 'Between two sends from one mailbox.' },
    { key: 'jitterMaxSeconds', label: 'Spacing: at most (seconds)', hint: 'The gap is random between the two.' },
    { key: 'bouncePauseBps', label: 'Pause at bounce rate (%)', hint: 'Hard bounces over sends.', percent: true },
    {
        key: 'complaintPauseBps',
        label: 'Pause at complaint rate (%)',
        hint: 'Keep under Google’s 0.3% line.',
        percent: true,
    },
    { key: 'rateMinSample', label: 'Judge rates after (sends)', hint: 'No rate is judged on fewer sends.' },
    { key: 'rateWindowDays', label: 'Rates over (days)', hint: 'The window bounces and complaints are counted in.' },
];

function SettingsDialog({
    workspaceId,
    settings,
    onClose,
}: {
    workspaceId: string;
    settings: SendingPoolSettingsView;
    onClose: () => void;
}) {
    const update = useUpdatePoolSettings(workspaceId);
    const [values, setValues] = useState<Record<string, string>>(() =>
        Object.fromEntries(
            SETTING_FIELDS.map((f) => [f.key, f.percent ? String(settings[f.key] / 100) : String(settings[f.key])]),
        ),
    );
    const submit = (event: FormEvent) => {
        event.preventDefault();
        const input = Object.fromEntries(
            SETTING_FIELDS.map((f) => [
                f.key,
                f.percent ? Math.round(Number(values[f.key]) * 100) : Number(values[f.key]),
            ]),
        ) as unknown as SendingPoolSettingsView;
        update.mutate(input, {
            onSuccess: () => {
                toast({ title: 'Pool settings saved', tone: 'success' });
                onClose();
            },
        });
    };
    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent>
                <form onSubmit={submit} noValidate>
                    <DialogTitle>Pool settings</DialogTitle>
                    <DialogDescription>Apply to every pool mailbox, from its next send.</DialogDescription>
                    <DialogBody className="grid gap-3 sm:grid-cols-2">
                        {SETTING_FIELDS.map((f) => (
                            <Field key={f.key} label={f.label} hint={f.hint} error={fieldErrorAt(update.error, f.key)}>
                                <Input
                                    type="number"
                                    inputMode="decimal"
                                    step={f.percent ? '0.01' : '1'}
                                    value={values[f.key] ?? ''}
                                    onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                                />
                            </Field>
                        ))}
                    </DialogBody>
                    {update.error && !SETTING_FIELDS.some((f) => fieldErrorAt(update.error, f.key)) && (
                        <p role="alert" className="m-0 px-6 text-sm text-danger">
                            {failureText(update.error)}
                        </p>
                    )}
                    <DialogFooter>
                        <Button type="button" variant="ghost" onClick={onClose}>
                            Cancel
                        </Button>
                        <Button type="submit" variant="primary" disabled={update.isPending}>
                            Save
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

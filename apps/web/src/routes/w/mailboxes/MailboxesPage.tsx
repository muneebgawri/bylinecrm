import { calendarGranted, type MailboxPurpose } from '@bylinecrm/shared';
import {
    Badge,
    Button,
    DataTableChrome,
    DropdownMenuItem,
    EmptyState,
    LoadingRegion,
    PageHeader,
    Skeleton,
    toast,
} from '@bylinecrm/ui';
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import {
    useCalendarSyncs,
    useCheckMailbox,
    useConnectMailbox,
    useDisconnectMailbox,
    useMailboxSyncs,
    useMailboxes,
    useOAuthClientStatus,
    useSyncCalendar,
    useSyncMailbox,
} from '../../../api/mailAdmin';
import { useMembersById } from '../../../api/records';
import type { CalendarSyncView, MailboxCheckView, MailboxSyncView, MailboxView } from '../../../api/types';
import { can, useMembership } from '../../../auth/capabilities';
import { ConfirmDialog } from '../../../components/ConfirmDialog';
import { GoogleStatus } from '../../../components/GoogleStatus';
import { failureText } from '../../../lib/errors';
import { formatRelative } from '../../../lib/format';
import { leaveFor } from '../../../lib/leaveFor';
import { useWorkspaceId } from '../../params';
import { CREATE_PARAM } from '../../paths';
import { BlocklistSection } from './BlocklistSection';
import { PoolHealthSection } from './PoolHealthSection';
import { ConnectMailboxDialog, PURPOSE_LABEL } from './ConnectMailboxDialog';
import {
    MAILBOX_CONNECT_PURPOSE_PARAM,
    MAILBOX_CONNECT_RESULT_PARAM,
    connectMessage,
    connectResultFrom,
} from './connectResults';

const CHECK_PROBLEM: Record<NonNullable<MailboxCheckView['problem']>, string> = {
    reconnect_needed: 'Google refused the stored access. Reconnect the mailbox.',
    scope_missing: 'Send or read access was withdrawn. Reconnect the mailbox.',
    scope_too_broad: 'The access now includes the whole mailbox. Reconnect it with send and read access only.',
};

/**
 * The workspace's Google mailboxes (doc 50 §E, FR-CRMS-1, FR-CRMS-2): where each stands, its sync,
 * its calendar's (CAL-1: a personal mailbox's Google Calendar, read for meetings and leads), the
 * actions its owner (or an admin) may take, and — for people who run outreach — the sending
 * pool's health (P3-2): allowance, warm-up, sending domain and pauses.
 */
export function MailboxesPage() {
    const workspaceId = useWorkspaceId();
    const membership = useMembership();
    const manage = can(membership, 'mailbox:manage');
    const status = useOAuthClientStatus(workspaceId);
    const list = useMailboxes(workspaceId);
    const [params, setParams] = useSearchParams();
    const [connecting, setConnecting] = useState(params.get(CREATE_PARAM) === '1');
    // The callback's result is read once, then taken off the URL so a reload doesn't repeat it.
    const [result] = useState(() => connectResultFrom(params.get(MAILBOX_CONNECT_RESULT_PARAM)));
    const [purpose] = useState(() => params.get(MAILBOX_CONNECT_PURPOSE_PARAM));
    // Announced once per visit: effects can run twice before the URL change lands (StrictMode in development).
    const announced = useRef(false);
    useEffect(() => {
        if (!params.has(MAILBOX_CONNECT_RESULT_PARAM) && !params.has(CREATE_PARAM)) return;
        if (result && !announced.current) {
            announced.current = true;
            const message = connectMessage(result, purpose);
            toast({ title: message.title, description: message.body, tone: message.tone });
        }
        const next = new URLSearchParams(params);
        next.delete(MAILBOX_CONNECT_RESULT_PARAM);
        next.delete(MAILBOX_CONNECT_PURPOSE_PARAM);
        next.delete(CREATE_PARAM);
        setParams(next, { replace: true });
    }, [params, purpose, result, setParams]);
    if (status.isError) throw status.error;
    if (list.isError) throw list.error;

    const configured = status.data?.configured ?? false;
    return (
        <div className="p-7 max-md:p-4">
            <PageHeader
                title="Mailboxes"
                subtitle="The Google Workspace mailboxes this workspace reads and sends from."
                actions={
                    manage && (
                        <Button
                            data-primary-action
                            data-primary-dialog
                            variant="primary"
                            shape="square"
                            disabled={!configured}
                            title={configured ? undefined : 'Google has to be set up first.'}
                            onClick={() => setConnecting(true)}
                        >
                            Connect mailbox
                        </Button>
                    )
                }
            />
            <div className="mb-4">
                {status.data ? (
                    !status.data.configured && <GoogleStatus workspaceId={workspaceId} status={status.data} />
                ) : (
                    <LoadingRegion label="Loading Google status">
                        <Skeleton className="h-9" />
                    </LoadingRegion>
                )}
            </div>
            <MailboxTable
                workspaceId={workspaceId}
                mailboxes={list.data}
                justConnected={
                    result === 'connected' && purpose !== 'postmaster' ? newestConnected(list.data ?? []) : null
                }
            />
            <PoolHealthSection workspaceId={workspaceId} />
            <BlocklistSection workspaceId={workspaceId} />
            {manage && (
                <ConnectMailboxDialog workspaceId={workspaceId} open={connecting} onOpenChange={setConnecting} />
            )}
        </div>
    );
}

/** The mailbox a successful callback just connected: the callback names no mailbox, so the newest. */
function newestConnected(list: readonly MailboxView[]): string | null {
    const live = list.filter((m) => m.status === 'connected' && m.connectedAt);
    live.sort((a, b) => (b.connectedAt ?? '').localeCompare(a.connectedAt ?? ''));
    return live[0]?.id ?? null;
}

function MailboxTable({
    workspaceId,
    mailboxes,
    justConnected,
}: {
    workspaceId: string;
    mailboxes: MailboxView[] | undefined;
    justConnected: string | null;
}) {
    const membership = useMembership();
    const names = useMembersById(workspaceId);
    const rows = mailboxes ?? [];
    // useQueries answers with a new array every render, so this lookup is rebuilt with it (a handful of rows).
    const syncQueries = useMailboxSyncs(workspaceId, rows);
    const syncs = new Map(rows.map((m, i) => [m.id, syncQueries[i]?.data] as const));
    const calendarQueries = useCalendarSyncs(workspaceId, rows);
    const calendars = new Map(rows.map((m, i) => [m.id, calendarQueries[i]?.data] as const));
    const sync = useSyncMailbox(workspaceId);
    const syncCalendar = useSyncCalendar(workspaceId);
    const check = useCheckMailbox(workspaceId);
    const connect = useConnectMailbox(workspaceId);
    const disconnect = useDisconnectMailbox(workspaceId);
    const [disconnecting, setDisconnecting] = useState<MailboxView | null>(null);

    const admin = can(membership, 'workspace:admin');
    const mayChange = (m: MailboxView) =>
        can(membership, 'mailbox:manage') && (admin || m.ownerMemberId === membership?.memberId);
    const ownerName = (m: MailboxView) =>
        m.ownerMemberId === membership?.memberId ? 'You' : (names.get(m.ownerMemberId) ?? 'Another member');
    const failed = (title: string) => (error: unknown) =>
        toast({ title, description: failureText(error), tone: 'danger' });

    const reconnect = (purpose: MailboxPurpose) =>
        connect.mutate(
            { purpose },
            { onSuccess: (start) => leaveFor(start.authorizeUrl), onError: failed('Could not start the reconnect') },
        );
    const syncNow = (m: MailboxView) =>
        sync.mutate(m.id, {
            onSuccess: (r) =>
                toast({
                    title: r.queued ? `Syncing ${m.email}` : `${m.email} is already syncing`,
                    tone: 'success',
                }),
            onError: failed('Sync did not start'),
        });
    const readCalendarNow = (m: MailboxView) =>
        syncCalendar.mutate(m.id, {
            onSuccess: (r) =>
                toast({
                    title: r.queued
                        ? `Reading the calendar of ${m.email}`
                        : `${m.email}’s calendar is already being read`,
                    tone: 'success',
                }),
            onError: failed('The calendar read did not start'),
        });
    const checkNow = (m: MailboxView) =>
        check.mutate(m.id, {
            onSuccess: (r) =>
                r.ok || !r.problem
                    ? toast({ title: `${m.email} is working`, tone: 'success' })
                    : toast({
                          title: `${m.email} needs attention`,
                          description: CHECK_PROBLEM[r.problem],
                          tone: 'danger',
                      }),
            onError: failed('The check did not run'),
        });

    return (
        <>
            <DataTableChrome
                data={{
                    label: 'Mailboxes',
                    loading: mailboxes === undefined,
                    rows,
                    getRowId: (m) => m.id,
                    empty: (
                        <EmptyState
                            className="m-4"
                            title="No mailbox connected"
                            body="Connect a Google Workspace mailbox to match its mail to your people and companies."
                        />
                    ),
                    columns: [
                        {
                            id: 'mailbox',
                            header: 'Mailbox',
                            phone: 'primary',
                            // Inline, so a phone card's one-line name truncates with an ellipsis rather than clipping.
                            cell: (m) => (
                                <span title={m.email}>
                                    <span className="font-medium">{m.email}</span>
                                    {m.id === justConnected && (
                                        <>
                                            {' '}
                                            <Badge status="accent" shape="pill">
                                                Just connected
                                            </Badge>
                                        </>
                                    )}
                                    {m.label && <span className="text-text-muted max-md:hidden"> · {m.label}</span>}
                                </span>
                            ),
                        },
                        {
                            id: 'status',
                            header: 'Status',
                            phone: 'secondary',
                            cell: (m) => <MailboxStatus mailbox={m} />,
                        },
                        {
                            id: 'sync',
                            header: 'Sync',
                            phone: 'secondary',
                            muted: true,
                            cell: (m) => <SyncState mailbox={m} sync={syncs.get(m.id)} />,
                        },
                        {
                            id: 'calendar',
                            header: 'Calendar',
                            phone: 'secondary',
                            muted: true,
                            cell: (m) => <CalendarState mailbox={m} sync={calendars.get(m.id)} />,
                        },
                        {
                            id: 'purpose',
                            header: 'Purpose',
                            phone: 'secondary',
                            cell: (m) => PURPOSE_LABEL[m.purpose],
                        },
                        { id: 'owner', header: 'Owner', phone: 'secondary', muted: true, cell: ownerName },
                    ],
                    rowActions: {
                        label: (m) => m.email,
                        items: (m) =>
                            mayChange(m) ? (
                                <>
                                    {m.status === 'connected' && (
                                        <>
                                            <DropdownMenuItem onSelect={() => syncNow(m)}>Sync now</DropdownMenuItem>
                                            <DropdownMenuItem onSelect={() => checkNow(m)}>
                                                Check connection
                                            </DropdownMenuItem>
                                            {m.purpose === 'personal' &&
                                                (calendarGranted(m.grantedScopes) ? (
                                                    <DropdownMenuItem onSelect={() => readCalendarNow(m)}>
                                                        Read calendar now
                                                    </DropdownMenuItem>
                                                ) : (
                                                    // Connecting again asks Google for the calendar too; the mail stays as
                                                    // it is. Only its owner: the connect signs in to the Google account of
                                                    // whoever starts it, so an admin would connect their own.
                                                    m.ownerMemberId === membership?.memberId && (
                                                        <DropdownMenuItem onSelect={() => reconnect('personal')}>
                                                            Connect calendar
                                                        </DropdownMenuItem>
                                                    )
                                                ))}
                                        </>
                                    )}
                                    {m.status !== 'connected' && (
                                        <DropdownMenuItem onSelect={() => reconnect(m.purpose)}>
                                            Reconnect
                                        </DropdownMenuItem>
                                    )}
                                    {m.status !== 'disconnected' && (
                                        <DropdownMenuItem
                                            destructive
                                            onSelect={() => {
                                                disconnect.reset();
                                                setDisconnecting(m);
                                            }}
                                        >
                                            Disconnect
                                        </DropdownMenuItem>
                                    )}
                                </>
                            ) : null,
                    },
                }}
            />
            <ConfirmDialog
                open={disconnecting !== null}
                onOpenChange={(open) => !open && setDisconnecting(null)}
                title={`Disconnect ${disconnecting?.email ?? ''}?`}
                body="Sync stops and the CRM gives up the mailbox’s access. Mail already synced stays on its records. You can connect it again later."
                confirm="Disconnect"
                pending={disconnect.isPending}
                error={disconnect.isError ? failureText(disconnect.error) : undefined}
                onConfirm={() =>
                    disconnecting &&
                    disconnect.mutate(disconnecting.id, {
                        onSuccess: (r) => {
                            toast({
                                title: `Disconnected ${r.mailbox.email}`,
                                description: r.revoked
                                    ? 'Google confirmed its access was revoked.'
                                    : 'Google did not confirm the revoke; remove the app’s access in the Google account’s security settings. The CRM no longer holds its tokens.',
                                tone: 'success',
                            });
                            setDisconnecting(null);
                        },
                    })
                }
            />
        </>
    );
}

function MailboxStatus({ mailbox }: { mailbox: MailboxView }) {
    if (mailbox.status === 'connected') {
        return (
            <Badge status="success" dot>
                Connected
            </Badge>
        );
    }
    if (mailbox.status === 'disconnected') return <Badge status="neutral">Disconnected</Badge>;
    return (
        <Badge status="warning" dot>
            Reconnect needed
        </Badge>
    );
}

function SyncState({ mailbox, sync }: { mailbox: MailboxView; sync: MailboxSyncView | undefined }) {
    if (mailbox.status === 'disconnected') return <span>—</span>;
    // Sync stops while Google refuses the stored access; the reason is what the owner acts on.
    if (mailbox.status === 'reconnect_needed') {
        // On a phone the "Reconnect needed" badge beside it already says sync is paused; the line keeps the reason.
        return (
            <span>
                <span className="max-md:hidden">Paused — </span>
                {mailbox.lastError?.message ?? 'Reconnect the mailbox to resume.'}
            </span>
        );
    }
    if (!sync) return <span>Checking…</span>;
    if (sync.status === 'syncing') return <span>Syncing now</span>;
    if (sync.status === 'failed') {
        return <span className="text-danger">Sync failed{sync.lastError ? `: ${sync.lastError.message}` : ''}</span>;
    }
    return sync.lastSyncedAt ? (
        <span>Synced {formatRelative(sync.lastSyncedAt)}</span>
    ) : (
        <span>Waiting for the first sync</span>
    );
}

/**
 * A personal mailbox's calendar (CAL-1): not connected until the mailbox's Google access includes it
 * (connecting the mailbox again asks for it), then when it was last read for meetings.
 */
function CalendarState({ mailbox, sync }: { mailbox: MailboxView; sync: CalendarSyncView | undefined }) {
    if (mailbox.purpose !== 'personal' || mailbox.status === 'disconnected') return <span>—</span>;
    if (mailbox.status === 'reconnect_needed') return <span>Paused</span>;
    if (!calendarGranted(mailbox.grantedScopes)) return <span>Not connected</span>;
    if (!sync) return <span>Checking…</span>;
    if (sync.status === 'syncing') return <span>Reading now</span>;
    if (sync.status === 'failed') {
        return <span className="text-danger">Read failed{sync.lastError ? `: ${sync.lastError.message}` : ''}</span>;
    }
    return sync.lastSyncedAt ? (
        <span>Read {formatRelative(sync.lastSyncedAt)}</span>
    ) : (
        <span>Waiting for the first read</span>
    );
}

import { Badge, Button, DataTableChrome, EmptyState, toast } from '@bylinecrm/ui';
import { useState } from 'react';
import { useMailHistoryBackfill, useStartMailHistoryBackfill } from '../../../api/mailAdmin';
import type { MailHistoryBackfillView } from '../../../api/types';
import { ConfirmDialog } from '../../../components/ConfirmDialog';
import { failureText } from '../../../lib/errors';
import { formatDate } from '../../../lib/format';

type Row = MailHistoryBackfillView['mailboxes'][number];

const STATUS: Record<NonNullable<Row['status']>, { label: string; tone: 'neutral' | 'success' | 'warning' }> = {
    running: { label: 'Importing', tone: 'neutral' },
    done: { label: 'Done', tone: 'success' },
    budget_reached: { label: 'Stopped: storage limit', tone: 'warning' },
};

const gib = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;

/** `2023-04-01` → `1 Apr 2023`, read as the calendar date it is (no time zone shift). */
function dayLabel(day: string): string {
    return new Intl.DateTimeFormat('en-GB', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        timeZone: 'UTC',
    }).format(new Date(`${day}T00:00:00Z`));
}

/**
 * The mail history backfill (an admin's): brings each Gmail mailbox's older mail onto the records it concerns, back to
 * the floor, a month at a time in the background. Only mail with one of the workspace's people in it is stored, and
 * the import stops at a storage limit — it can be started again once that is raised.
 */
export function MailHistorySection({ workspaceId }: { workspaceId: string }) {
    const view = useMailHistoryBackfill(workspaceId);
    const start = useStartMailHistoryBackfill(workspaceId);
    const [confirming, setConfirming] = useState(false);
    if (view.isError) throw view.error;
    const floor = view.data ? dayLabel(view.data.floor) : '';
    const running = view.data?.mailboxes.some((m) => m.status === 'running') ?? false;

    return (
        <section aria-labelledby="mail-history-title" className="mt-8">
            <h2 id="mail-history-title" className="m-0 mb-1 text-base font-semibold">
                Mail history
            </h2>
            <p className="m-0 mb-3 max-w-[65ch] text-[13px] text-text-muted">
                Imports each mailbox’s older mail{floor && ` back to ${floor}`} onto the records it concerns, so mail
                sent from Gmail counts toward contact attempts and status. Only mail with one of the workspace’s people
                in it is stored.
                {view.data && ` Storage used: ${gib(view.data.usedBytes)} of ${gib(view.data.maxBytes)}.`}
            </p>
            <DataTableChrome
                toolbar={{
                    extra: (
                        <Button
                            shape="square"
                            size="sm"
                            disabled={!view.data || running}
                            title={running ? 'An import is running.' : undefined}
                            onClick={() => {
                                start.reset();
                                setConfirming(true);
                            }}
                        >
                            {floor ? `Import mail since ${floor}` : 'Import mail history'}
                        </Button>
                    ),
                }}
                data={{
                    label: 'Mail history',
                    loading: view.isPending,
                    rows: view.data?.mailboxes ?? [],
                    getRowId: (m) => m.mailboxId,
                    empty: <EmptyState className="m-4" title="No Gmail mailboxes" body="Connect a mailbox first." />,
                    columns: [
                        { id: 'mailbox', header: 'Mailbox', cell: (m) => m.email },
                        {
                            id: 'status',
                            header: 'Status',
                            cell: (m) =>
                                m.status ? (
                                    <Badge status={STATUS[m.status].tone}>{STATUS[m.status].label}</Badge>
                                ) : (
                                    <span className="text-text-muted">Not started</span>
                                ),
                        },
                        {
                            id: 'reached',
                            header: 'Reached back to',
                            muted: true,
                            phone: 'meta',
                            cell: (m) => (m.reachedBack ? formatDate(m.reachedBack) : '—'),
                        },
                        { id: 'imported', header: 'Imported', muted: true, cell: (m) => m.imported.toLocaleString() },
                    ],
                }}
            />
            <ConfirmDialog
                open={confirming}
                onOpenChange={setConfirming}
                title={`Import mail since ${floor}?`}
                body="Every connected Gmail mailbox is read back to that date in the background, a month at a time. Mail with one of the workspace’s people in it lands on their timelines and counts toward their contact status; other mail is not stored. It can take hours."
                confirm="Start import"
                pending={start.isPending}
                error={start.isError ? failureText(start.error) : undefined}
                onConfirm={() =>
                    start.mutate(undefined, {
                        onSuccess: () => {
                            setConfirming(false);
                            toast({ title: 'Mail history import started', tone: 'success' });
                        },
                    })
                }
            />
        </section>
    );
}

import {
    SUPPRESSION_NOTE_MAX,
    SUPPRESSION_REASONS,
    normaliseSuppressionAddress,
    type SuppressionReason,
    type SuppressionSource,
} from '@bylinecrm/shared';
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
import { useAddSuppression, useLiftSuppression, useSuppressions } from '../../../api/mailAdmin';
import type { SuppressionView } from '../../../api/types';
import { useCan } from '../../../auth/capabilities';
import { ConfirmDialog } from '../../../components/ConfirmDialog';
import { failureText } from '../../../lib/errors';
import { formatDate } from '../../../lib/format';
import { useDebounced } from '../../../lib/useDebounced';
import { useWorkspaceId } from '../../params';

type Tab = 'all' | SuppressionReason;

/** The reason as a tab, and — short enough for a phone card — as a row's badge. */
const REASON_TAB: Record<SuppressionReason, string> = {
    unsubscribe: 'Unsubscribed',
    hard_bounce: 'Hard bounces',
    complaint: 'Complaints',
    manual: 'Manual',
};
const REASON_BADGE: Record<SuppressionReason, string> = {
    unsubscribe: 'Unsubscribed',
    hard_bounce: 'Hard bounce',
    complaint: 'Spam complaint',
    manual: 'Manual',
};

const REASON_TONE: Record<SuppressionReason, 'danger' | 'warning' | 'neutral'> = {
    unsubscribe: 'neutral',
    hard_bounce: 'warning',
    complaint: 'danger',
    manual: 'neutral',
};

const SOURCE_LABEL: Record<SuppressionSource, string> = {
    recipient: 'Unsubscribe link',
    member: 'A member',
    provider: 'Delivery report',
};

/**
 * The suppression list (P3-1, FR-CRMS-7): addresses the workspace never mails. Every send and every
 * enrolment checks it; a refused send names the address and why. A member with outreach rights
 * reads it and suppresses an address by hand; an admin lifts a hard bounce or a manual entry, with a
 * note. An unsubscribe or a spam complaint is the person's own choice and is never lifted here.
 */
export function Suppression() {
    const workspaceId = useWorkspaceId();
    const admin = useCan('workspace:admin');
    const [tab, setTab] = useState<Tab>('all');
    const [q, setQ] = useState('');
    const term = useDebounced(q).trim();
    const list = useSuppressions(workspaceId, { reason: tab === 'all' ? undefined : tab, q: term || undefined });
    const [adding, setAdding] = useState(false);
    const [lifting, setLifting] = useState<SuppressionView | null>(null);
    if (list.isError) throw list.error;
    const rows = list.data?.pages.flatMap((page) => page.items) ?? [];

    return (
        <section aria-labelledby="suppression-title">
            <h2 id="suppression-title" className="sr-only">
                Suppression
            </h2>
            <p className="m-0 mb-3 max-w-[65ch] text-[13px] text-text-muted">
                Nobody in the workspace can send to these addresses, and sequences never enrol them. Unsubscribes and
                spam complaints are the person’s own choice: only they can undo them.
            </p>
            <DataTableChrome
                tabs={[
                    { id: 'all', label: 'All' },
                    ...SUPPRESSION_REASONS.map((reason) => ({ id: reason, label: REASON_TAB[reason] })),
                ]}
                activeTab={tab}
                onTabChange={setTab}
                search={{ value: q, onChange: setQ, placeholder: 'Search…' }}
                toolbar={{
                    extra: (
                        <Button
                            data-primary-action
                            data-primary-dialog
                            variant="primary"
                            shape="square"
                            size="sm"
                            onClick={() => setAdding(true)}
                        >
                            Suppress an address
                        </Button>
                    ),
                }}
                footer={
                    list.hasNextPage ? (
                        <Button
                            variant="ghost"
                            size="sm"
                            loading={list.isFetchingNextPage}
                            onClick={() => void list.fetchNextPage()}
                        >
                            Load more
                        </Button>
                    ) : undefined
                }
                data={{
                    label: 'Suppressed addresses',
                    loading: list.isPending,
                    rows,
                    getRowId: (entry) => entry.id,
                    empty:
                        term || tab !== 'all' ? (
                            <EmptyState
                                className="m-4"
                                title="No addresses match"
                                body="Clear the search or choose another tab."
                            />
                        ) : (
                            <EmptyState
                                className="m-4"
                                title="No suppressed addresses"
                                body="People who unsubscribe, addresses that hard-bounce and spam complaints land here on their own. You can also suppress an address by hand."
                            />
                        ),
                    columns: [
                        {
                            id: 'address',
                            header: 'Address',
                            className: 'font-medium',
                            cell: (entry) => <span className="break-all">{entry.address}</span>,
                        },
                        {
                            id: 'reason',
                            header: 'Reason',
                            cell: (entry) => (
                                <Badge status={REASON_TONE[entry.reason]}>{REASON_BADGE[entry.reason]}</Badge>
                            ),
                        },
                        // On a phone the card keeps what decides a send — the address, why, and when.
                        {
                            id: 'source',
                            header: 'Added by',
                            muted: true,
                            phone: 'hidden',
                            cell: (entry) => SOURCE_LABEL[entry.source],
                        },
                        {
                            id: 'note',
                            header: 'Note',
                            muted: true,
                            phone: 'hidden',
                            cell: (entry) => entry.note ?? '—',
                        },
                        {
                            id: 'added',
                            header: 'Added',
                            muted: true,
                            phone: 'meta',
                            cell: (entry) => formatDate(entry.createdAt),
                        },
                    ],
                    rowActions: {
                        label: (entry) => entry.address,
                        items: (entry) =>
                            admin && entry.liftable ? (
                                <DropdownMenuItem destructive onSelect={() => setLifting(entry)}>
                                    Lift
                                </DropdownMenuItem>
                            ) : null,
                    },
                }}
            />
            <AddDialog workspaceId={workspaceId} open={adding} onOpenChange={setAdding} />
            <LiftDialog workspaceId={workspaceId} entry={lifting} onClose={() => setLifting(null)} />
        </section>
    );
}

function AddDialog({
    workspaceId,
    open,
    onOpenChange,
}: {
    workspaceId: string;
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    const add = useAddSuppression(workspaceId);
    const [address, setAddress] = useState('');
    const [note, setNote] = useState('');
    const [invalid, setInvalid] = useState(false);
    const close = () => {
        setAddress('');
        setNote('');
        setInvalid(false);
        add.reset();
        onOpenChange(false);
    };
    const submit = (event: FormEvent) => {
        event.preventDefault();
        // The API's own rule, so a typo is caught here and a correct value is sent normalised.
        const normalised = normaliseSuppressionAddress(address);
        if (!normalised) {
            setInvalid(true);
            return;
        }
        add.mutate(
            { address: normalised, note: note.trim() || undefined },
            {
                onSuccess: (created) => {
                    toast({ title: `Suppressed ${created.address}` });
                    close();
                },
            },
        );
    };
    const addressError = invalid
        ? 'Enter an address like someone@example.com.'
        : (fieldErrorAt(add.error, 'address') ?? (add.isError ? failureText(add.error) : undefined));
    return (
        <Dialog open={open} onOpenChange={(next) => !next && close()}>
            <DialogContent>
                <DialogTitle>Suppress an address</DialogTitle>
                <DialogDescription>
                    Nobody in the workspace can send to it from now on, and sequences will not enrol it.
                </DialogDescription>
                <form onSubmit={submit} noValidate>
                    <DialogBody className="flex flex-col gap-4">
                        <Field label="Address" required error={addressError}>
                            <Input
                                value={address}
                                onChange={(e) => {
                                    setAddress(e.target.value);
                                    setInvalid(false);
                                }}
                                autoComplete="off"
                                spellCheck={false}
                                inputMode="email"
                                placeholder="someone@example.com"
                            />
                        </Field>
                        <Field label="Note" hint="Why, for whoever reads the list later.">
                            <Textarea
                                value={note}
                                maxLength={SUPPRESSION_NOTE_MAX}
                                onChange={(e) => setNote(e.target.value)}
                                rows={3}
                            />
                        </Field>
                    </DialogBody>
                    <DialogFooter>
                        <Button type="button" shape="square" onClick={close}>
                            Cancel
                        </Button>
                        <Button
                            type="submit"
                            variant="primary"
                            shape="square"
                            loading={add.isPending}
                            disabled={!address.trim()}
                        >
                            Suppress
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

function LiftDialog({
    workspaceId,
    entry,
    onClose,
}: {
    workspaceId: string;
    entry: SuppressionView | null;
    onClose: () => void;
}) {
    const lift = useLiftSuppression(workspaceId);
    const [note, setNote] = useState('');
    const close = () => {
        setNote('');
        lift.reset();
        onClose();
    };
    return (
        <ConfirmDialog
            open={entry !== null}
            onOpenChange={(open) => !open && close()}
            title={`Lift ${entry?.address ?? ''}?`}
            body="Mail can be sent to it again. The entry stays on record with your note."
            confirm="Lift"
            pending={lift.isPending}
            confirmDisabled={note.trim() === ''}
            error={fieldErrorAt(lift.error, 'note') ?? (lift.isError ? failureText(lift.error) : undefined)}
            onConfirm={() =>
                entry &&
                lift.mutate(
                    { id: entry.id, note: note.trim() },
                    {
                        onSuccess: () => {
                            toast({ title: `Lifted ${entry.address}` });
                            close();
                        },
                    },
                )
            }
        >
            <Field label="Why" required>
                <Textarea
                    value={note}
                    maxLength={SUPPRESSION_NOTE_MAX}
                    onChange={(e) => setNote(e.target.value)}
                    rows={3}
                />
            </Field>
        </ConfirmDialog>
    );
}

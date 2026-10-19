import type { RecordObject } from '@bylinecrm/shared';
import {
    Button,
    Dialog,
    DialogBody,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogTitle,
    Field,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    Textarea,
    toast,
} from '@bylinecrm/ui';
import { useState, type FormEvent } from 'react';
import { ApiError } from '../../../api/client';
import { currentMembers, useMembersSummary } from '../../../api/records';
import { useDecideTransfer, useProposeTransfer, useRecordTransfers } from '../../../api/transfers';
import type { TransferView } from '../../../api/types';
import { useCan, useMembership, usePermission } from '../../../auth/capabilities';
import { InlineSelect } from './InlineEdit';

/**
 * The owner field (OWN-1, #200). A record changes hands only through a transfer, so the field does
 * what the caller may do:
 *
 * - **A manager** (`record:transfer`) picks the new owner and the record — with its unit (a company's
 *   people and open deals) — moves at once; both members are told.
 * - **The owner** hands it on: "Hand on…" offers it to a member, who accepts or declines.
 * - **Anyone with `record:write`** may claim, or assign, a record nobody owns.
 * - **Everyone else** sees who owns it, and why they cannot change it.
 *
 * An open offer shows under the field: the receiver accepts or declines it here, the proposer (or a
 * manager) takes it back.
 */
export function OwnerControl({
    workspaceId,
    object,
    recordId,
    value,
    onSave,
    id,
}: {
    workspaceId: string;
    object: RecordObject;
    recordId: string;
    value: string | null;
    /** A plain owner write: claiming an unowned record, or a manager clearing one. */
    onSave: (ownerId: string | null) => Promise<unknown>;
    id?: string;
}) {
    const membership = useMembership();
    const me = membership?.memberId ?? null;
    const write = usePermission('record:write');
    const canForce = useCan('record:transfer');
    const members = useMembersSummary(workspaceId);
    const history = useRecordTransfers(workspaceId, object, recordId);
    const propose = useProposeTransfer(workspaceId);
    const [handing, setHanding] = useState(false);

    const options = currentMembers(members.data).map((m) => ({ value: m.memberId, label: m.name ?? 'Unnamed member' }));
    const open = history.data?.find((t) => t.status === 'proposed') ?? null;
    const isOwner = value !== null && value === me;
    const ownScoped = membership?.recordScope === 'own';

    const save = async (next: string | null) => {
        if (next === null || value === null) return onSave(next);
        const moved = await propose.mutateAsync({ object, recordId, toMemberId: next });
        toast({ tone: 'success', title: movedText(moved) });
        return moved;
    };

    const canEdit = write.allowed && (canForce || (value === null && !ownScoped));
    const reason = !write.allowed
        ? write.reason
        : isOwner
          ? 'Use “Hand on…” to offer it to someone; they accept or decline.'
          : 'Owned by someone else. Ask them, or a manager, to hand it on.';

    return (
        <div className="grid gap-1.5">
            <InlineSelect
                id={id}
                label="Owner"
                path="ownerId"
                value={value}
                options={options}
                clearLabel="Unassigned"
                canEdit={canEdit}
                reason={reason}
                onSave={save}
            />
            {isOwner && !canForce && !open && write.allowed && (
                <Button
                    size="sm"
                    variant="ghost"
                    shape="square"
                    className="justify-self-start"
                    onClick={() => setHanding(true)}
                >
                    Hand on…
                </Button>
            )}
            {open && <OpenOffer workspaceId={workspaceId} offer={open} me={me} canForce={canForce} />}
            <HandOnDialog
                open={handing}
                onClose={() => setHanding(false)}
                options={options.filter((o) => o.value !== value)}
                pending={propose.isPending}
                onSubmit={async (toMemberId, why) => {
                    const offered = await propose.mutateAsync({
                        object,
                        recordId,
                        toMemberId,
                        ...(why ? { reason: why } : {}),
                    });
                    toast({
                        tone: 'success',
                        title: `Offered to ${offered.to.name ?? 'them'}. They’ll be asked to accept.`,
                    });
                    setHanding(false);
                }}
            />
        </div>
    );
}

function movedText(t: TransferView): string {
    const extra =
        t.moved.length > 1 ? `, with ${t.moved.length - 1} related record${t.moved.length > 2 ? 's' : ''}` : '';
    return `Moved to ${t.to.name ?? 'them'}${extra}.`;
}

/** An offer waiting on its receiver: their accept / decline, or the proposer's (or a manager's) cancel. */
function OpenOffer({
    workspaceId,
    offer,
    me,
    canForce,
}: {
    workspaceId: string;
    offer: TransferView;
    me: string | null;
    canForce: boolean;
}) {
    const decide = useDecideTransfer(workspaceId);
    const act = async (action: 'accept' | 'decline' | 'cancel') => {
        try {
            const done = await decide.mutateAsync({ id: offer.id, action });
            toast({
                tone: 'success',
                title: action === 'accept' ? movedText(done) : action === 'decline' ? 'Declined.' : 'Offer taken back.',
            });
        } catch (e) {
            toast({ tone: 'danger', title: e instanceof ApiError ? e.message : 'Could not do that.' });
        }
    };
    const from = offer.from?.name ?? 'Someone';
    const to = offer.to.name ?? 'a member';
    const mine = offer.to.memberId === me;
    const theirs = offer.proposedBy.memberId === me;
    return (
        <div role="status" className="rounded-md border border-border bg-surface-raised px-2.5 py-2 text-xs">
            <p className="m-0">{mine ? `${from} offers this to you.` : `Offered to ${to}, waiting for them.`}</p>
            {offer.reason && <p className="m-0 mt-0.5 text-text-muted">“{offer.reason}”</p>}
            <div className="mt-1.5 flex flex-wrap gap-1.5">
                {mine && (
                    <>
                        <Button
                            size="sm"
                            variant="primary"
                            shape="square"
                            loading={decide.isPending}
                            onClick={() => act('accept')}
                        >
                            Accept
                        </Button>
                        <Button size="sm" shape="square" disabled={decide.isPending} onClick={() => act('decline')}>
                            Decline
                        </Button>
                    </>
                )}
                {!mine && (theirs || canForce) && (
                    <Button size="sm" shape="square" disabled={decide.isPending} onClick={() => act('cancel')}>
                        Take back
                    </Button>
                )}
            </div>
        </div>
    );
}

function HandOnDialog({
    open,
    onClose,
    options,
    pending,
    onSubmit,
}: {
    open: boolean;
    onClose: () => void;
    options: { value: string; label: string }[];
    pending: boolean;
    onSubmit: (toMemberId: string, reason: string) => Promise<void>;
}) {
    const [to, setTo] = useState('');
    const [reason, setReason] = useState('');
    const [error, setError] = useState<string | null>(null);
    const close = () => {
        setTo('');
        setReason('');
        setError(null);
        onClose();
    };
    const submit = async (e: FormEvent) => {
        e.preventDefault();
        try {
            await onSubmit(to, reason.trim());
            setTo('');
            setReason('');
            setError(null);
        } catch (err) {
            setError(err instanceof ApiError ? err.message : 'Could not offer it.');
        }
    };
    return (
        <Dialog open={open} onOpenChange={(o) => !o && close()}>
            <DialogContent>
                <DialogTitle>Hand on this record</DialogTitle>
                <DialogDescription>
                    They’re asked to accept. If the record is a company, or a person at a company you own, its people
                    and open deals go with it.
                </DialogDescription>
                <form onSubmit={submit}>
                    <DialogBody className="grid gap-4">
                        <Field label="To" required error={error}>
                            <Select value={to} onValueChange={setTo}>
                                <SelectTrigger aria-label="To">
                                    <SelectValue placeholder="Choose a member" />
                                </SelectTrigger>
                                <SelectContent>
                                    {options.map((o) => (
                                        <SelectItem key={o.value} value={o.value}>
                                            {o.label}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </Field>
                        <Field label="Why (optional)">
                            <Textarea value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
                        </Field>
                    </DialogBody>
                    <DialogFooter>
                        <Button type="button" onClick={close}>
                            Cancel
                        </Button>
                        <Button type="submit" variant="primary" loading={pending} disabled={!to}>
                            Offer
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

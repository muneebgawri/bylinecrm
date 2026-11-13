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
import { useNavigate } from 'react-router';
import { ApiError } from '../../../api/client';
import { useOwnershipSettings } from '../../../api/ownership';
import { currentMembers, useMembersSummary } from '../../../api/records';
import {
    transfers,
    useDecideTransfer,
    useProposeTransfer,
    useRecordTransfers,
    useReleaseRecord,
} from '../../../api/transfers';
import type { TransferPreviewView, TransferView } from '../../../api/types';
import { useCan, useMembership, usePermission } from '../../../auth/capabilities';
import { paths } from '../../paths';
import { InlineSelect } from './InlineEdit';

/**
 * The owner field (OWN-1, #200). A record changes hands only through a transfer, so the field does
 * what the caller may do:
 *
 * - **A manager** (`record:transfer`) picks the new owner and the record moves at once. A company, or a person
 *   at one, takes the whole company — every person at it and their open deals, whoever holds them (OWN-1b) — so
 *   when the move takes more than the record, it is confirmed first, by who loses what. Everyone is told.
 * - **The owner** hands it on: "Hand on…" offers it to a member, who accepts or declines. Or gives it up:
 *   "Release…" sends it at once to the house account (Settings → Ownership), for a manager to hand out again —
 *   the way to let go of a lead without deleting it. Shown only while a house account is set.
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
    const release = useReleaseRecord(workspaceId);
    const settings = useOwnershipSettings(workspaceId);
    const navigate = useNavigate();
    const [handing, setHanding] = useState(false);
    const [releasing, setReleasing] = useState(false);
    /** OWN-1b: a manager's move that takes more than the record, waiting on the manager's confirmation. */
    const [confirming, setConfirming] = useState<{
        toMemberId: string;
        toName: string;
        preview: TransferPreviewView;
        resolve: (done: boolean) => void;
    } | null>(null);

    const options = currentMembers(members.data).map((m) => ({ value: m.memberId, label: m.name ?? 'Unnamed member' }));
    const open = history.data?.find((t) => t.status === 'proposed') ?? null;
    const isOwner = value !== null && value === me;
    const ownScoped = membership?.recordScope === 'own';
    const houseId = settings.data?.releaseToMemberId ?? null;
    const houseName = options.find((o) => o.value === houseId)?.label ?? 'the house account';
    const canRelease = houseId !== null && houseId !== me;

    const save = async (next: string | null) => {
        // Clearing the owner, or a member claiming a record nobody owns, is a plain write. A manager's assignment
        // is a move (OWN-1b): the record's company goes with it, so a larger move is confirmed first.
        if (next === null || (value === null && !canForce)) return onSave(next);
        if (canForce) {
            const preview = await transfers.preview(workspaceId, { object, recordId, toMemberId: next });
            if (preview.total > 1) {
                const toName = options.find((o) => o.value === next)?.label ?? 'them';
                const go = await new Promise<boolean>((resolve) =>
                    setConfirming({ toMemberId: next, toName, preview, resolve }),
                );
                setConfirming(null);
                if (!go) return false;
            }
        }
        const moved = await propose.mutateAsync({ object, recordId, toMemberId: next });
        toast({ tone: 'success', title: movedText(moved) });
        return moved;
    };

    const canEdit = write.allowed && (canForce || (value === null && !ownScoped));
    const reason = !write.allowed
        ? write.reason
        : isOwner
          ? canRelease
              ? 'Use “Hand on…” to offer it to someone, or “Release…” to give it up.'
              : 'Use “Hand on…” to offer it to someone; they accept or decline.'
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
                <div className="flex flex-wrap gap-1.5">
                    <Button size="sm" variant="ghost" shape="square" onClick={() => setHanding(true)}>
                        Hand on…
                    </Button>
                    {canRelease && (
                        <Button size="sm" variant="ghost" shape="square" onClick={() => setReleasing(true)}>
                            Release…
                        </Button>
                    )}
                </div>
            )}
            {open && <OpenOffer workspaceId={workspaceId} offer={open} me={me} canForce={canForce} />}
            {confirming && (
                <ConfirmMoveDialog
                    toName={confirming.toName}
                    preview={confirming.preview}
                    onAnswer={(go) => confirming.resolve(go)}
                />
            )}
            <ReleaseDialog
                open={releasing}
                onClose={() => setReleasing(false)}
                toName={houseName}
                pending={release.isPending}
                onSubmit={async (why) => {
                    const done = await release.mutateAsync({ object, recordId, ...(why ? { note: why } : {}) });
                    toast({ tone: 'success', title: `Released to ${done.to.name ?? houseName}.` });
                    setReleasing(false);
                    // It is no longer theirs: a member who keeps to their own records cannot stay on its page.
                    if (ownScoped) void navigate(LIST_PATH[object](workspaceId));
                }}
            />
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

/** Where a member lands after releasing a record they can no longer open. */
const LIST_PATH: Record<RecordObject, (workspaceId: string) => string> = {
    person: paths.people,
    company: paths.companies,
    opportunity: paths.deals,
};

/** One member's losses, as the confirmation reads them: "Arvore Partners, 3 contacts and 1 open deal". */
function lossText(l: TransferPreviewView['losers'][number]): string {
    const parts = [
        l.companies > 0 ? (l.companies === 1 ? 'the company' : `${l.companies} companies`) : null,
        l.people > 0 ? `${l.people} contact${l.people === 1 ? '' : 's'}` : null,
        l.deals > 0 ? `${l.deals} open deal${l.deals === 1 ? '' : 's'}` : null,
    ].filter((p): p is string => p !== null);
    return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : (parts[0] ?? 'nothing');
}

/**
 * OWN-1b: the manager's confirmation before a move that takes more than the record — the whole company, by who
 * loses what. Nothing moves until they confirm.
 */
function ConfirmMoveDialog({
    toName,
    preview,
    onAnswer,
}: {
    toName: string;
    preview: TransferPreviewView;
    onAnswer: (go: boolean) => void;
}) {
    return (
        <Dialog open onOpenChange={(o) => !o && onAnswer(false)}>
            <DialogContent>
                <DialogTitle>Move the whole company to {toName}?</DialogTitle>
                <DialogDescription>
                    The company and everyone at it go to {toName}, with their open deals, so one person owns the
                    account. Everyone below is told.
                </DialogDescription>
                <DialogBody>
                    <ul className="m-0 grid list-none gap-3 p-0">
                        {preview.losers.map((l) => (
                            <li key={l.member?.memberId ?? 'nobody'} className="text-[13px]">
                                <span className="font-medium text-text">
                                    {l.member ? (l.member.name ?? 'A member') : 'Nobody (unowned)'}
                                </span>{' '}
                                <span className="text-text-muted">
                                    {l.member ? 'loses' : '—'} {lossText(l)}
                                </span>
                                {l.names.length > 0 && (
                                    <span className="block text-text-muted">
                                        {l.names.join(', ')}
                                        {l.people + l.deals + l.companies > l.names.length ? ', …' : ''}
                                    </span>
                                )}
                            </li>
                        ))}
                    </ul>
                </DialogBody>
                <DialogFooter>
                    <Button type="button" onClick={() => onAnswer(false)}>
                        Cancel
                    </Button>
                    <Button type="button" variant="primary" onClick={() => onAnswer(true)}>
                        Move {preview.total} records
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
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

/** The owner's confirmation before giving a record up: where it goes, what goes with it, and (optionally) why. */
function ReleaseDialog({
    open,
    onClose,
    toName,
    pending,
    onSubmit,
}: {
    open: boolean;
    onClose: () => void;
    toName: string;
    pending: boolean;
    onSubmit: (reason: string) => Promise<void>;
}) {
    const [reason, setReason] = useState('');
    const [error, setError] = useState<string | null>(null);
    const close = () => {
        setReason('');
        setError(null);
        onClose();
    };
    const submit = async (e: FormEvent) => {
        e.preventDefault();
        try {
            await onSubmit(reason.trim());
            setReason('');
            setError(null);
        } catch (err) {
            setError(err instanceof ApiError ? err.message : 'Could not release it.');
        }
    };
    return (
        <Dialog open={open} onOpenChange={(o) => !o && close()}>
            <DialogContent>
                <DialogTitle>Release this record</DialogTitle>
                <DialogDescription>
                    It goes to {toName} now, with its history, for a manager to give to someone else. It stops being
                    yours. If the record is a company, or a person at a company you own, its people and open deals go
                    with it.
                </DialogDescription>
                <form onSubmit={submit}>
                    <DialogBody className="grid gap-4">
                        <Field label="Why (optional)" error={error}>
                            <Textarea value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
                        </Field>
                    </DialogBody>
                    <DialogFooter>
                        <Button type="button" onClick={close}>
                            Cancel
                        </Button>
                        <Button type="submit" variant="primary" loading={pending}>
                            Release
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
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

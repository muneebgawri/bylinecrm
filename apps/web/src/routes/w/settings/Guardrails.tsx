import {
    GUARDRAIL_KINDS,
    GUARDRAIL_KIND_LABELS,
    GUARDRAIL_REASON_MAX,
    type GuardrailKind,
    type GuardrailOutcome,
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
    EmptyState,
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
import { Link } from 'react-router';
import { useGuardrailEvents, useGuardrailSettings, useMarkLegitimate } from '../../../api/guardrails';
import { useReputationSettings } from '../../../api/reputation';
import { useCan } from '../../../auth/capabilities';
import type { GuardrailEventView, GuardrailEventsQuery } from '../../../api/types';
import { failureText } from '../../../lib/errors';
import { formatRelative } from '../../../lib/format';
import { useWorkspaceId } from '../../params';
import { paths } from '../../paths';
import { GuardrailSettingsDialog } from './GuardrailSettingsDialog';
import { PausedMailboxes } from './PausedMailboxes';
import { UnsyncedMembers } from './UnsyncedMembers';
import { ReputationSettingsDialog } from './ReputationSettingsDialog';

const OUTCOME_LABEL: Record<GuardrailOutcome, string> = {
    blocked: 'Blocked',
    warned: 'Warned',
    allowed: 'Let through',
    deferred: 'Deferred',
};
const OUTCOME_TONE: Record<GuardrailOutcome, 'danger' | 'warning' | 'neutral'> = {
    blocked: 'danger',
    warned: 'warning',
    allowed: 'neutral',
    deferred: 'neutral',
};
const ALL = 'all';

/**
 * Guardrails (GUARD-1, #202): every time the recipient guard stopped a member mailing another member's
 * lead, a prospect in negotiation, a customer or a suppressed address — and every time it let a manager
 * through — newest first, with filters. A reviewer marks an event legitimate with a reason, which is kept.
 * Reviewers only (`guardrail:review`); the server is the gate.
 */
export function Guardrails() {
    const workspaceId = useWorkspaceId();
    const [kind, setKind] = useState<GuardrailKind | typeof ALL>(ALL);
    const [reviewed, setReviewed] = useState<'false' | 'true' | typeof ALL>('false');
    const q: GuardrailEventsQuery = {
        limit: 100,
        ...(kind === ALL ? {} : { kind }),
        ...(reviewed === ALL ? {} : { reviewed }),
    };
    const events = useGuardrailEvents(workspaceId, q);
    const [marking, setMarking] = useState<GuardrailEventView | null>(null);
    const admin = useCan('workspace:admin');
    const reputation = useReputationSettings(workspaceId, admin);
    const [editingReputation, setEditingReputation] = useState(false);
    const settings = useGuardrailSettings(workspaceId, admin);
    const [editingPoaching, setEditingPoaching] = useState(false);
    const rows = events.data?.items ?? [];

    return (
        <section aria-labelledby="guardrails-title">
            <h2 id="guardrails-title" className="sr-only">
                Guardrails
            </h2>
            <p className="m-0 mb-3 max-w-[65ch] text-[13px] text-text-muted">
                Every send, reply, scheduled send and sequence passes the recipient guard. These are the times it
                stopped someone mailing another member’s lead, a prospect in negotiation, a customer or a suppressed
                address — and the times it let a manager through. Every CSV export is here too (Export): who, what, how
                many rows, and whether only their own. Mark one legitimate when there was a good reason.
            </p>
            <PausedMailboxes workspaceId={workspaceId} />
            <UnsyncedMembers workspaceId={workspaceId} />
            <DataTableChrome
                toolbar={{
                    extra: (
                        <div className="flex flex-wrap gap-2">
                            <Select value={kind} onValueChange={(v) => setKind(v as GuardrailKind | typeof ALL)}>
                                <SelectTrigger aria-label="Why" className="w-56">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value={ALL}>Every reason</SelectItem>
                                    {GUARDRAIL_KINDS.map((k) => (
                                        <SelectItem key={k} value={k}>
                                            {GUARDRAIL_KIND_LABELS[k]}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                            <Select
                                value={reviewed}
                                onValueChange={(v) => setReviewed(v as 'false' | 'true' | typeof ALL)}
                            >
                                <SelectTrigger aria-label="Reviewed" className="w-44">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="false">Not reviewed</SelectItem>
                                    <SelectItem value="true">Marked legitimate</SelectItem>
                                    <SelectItem value={ALL}>All</SelectItem>
                                </SelectContent>
                            </Select>
                            {admin && reputation.data && (
                                <Button shape="square" size="sm" onClick={() => setEditingReputation(true)}>
                                    Sender reputation
                                </Button>
                            )}
                            {admin && settings.data && (
                                <Button shape="square" size="sm" onClick={() => setEditingPoaching(true)}>
                                    Poaching alerts
                                </Button>
                            )}
                        </div>
                    ),
                }}
                data={{
                    label: 'Guardrail events',
                    loading: events.isPending,
                    rows,
                    getRowId: (e) => e.id,
                    empty: (
                        <EmptyState
                            className="m-4"
                            title="Nothing here"
                            body="No one has been stopped by a guardrail with these filters."
                        />
                    ),
                    columns: [
                        { id: 'when', header: 'When', cell: (e) => formatRelative(e.createdAt) },
                        {
                            id: 'who',
                            header: 'Who',
                            className: 'font-medium',
                            cell: (e) => e.actor?.name ?? 'A member',
                        },
                        {
                            id: 'outcome',
                            header: 'Outcome',
                            cell: (e) => <Badge status={OUTCOME_TONE[e.outcome]}>{OUTCOME_LABEL[e.outcome]}</Badge>,
                        },
                        { id: 'kind', header: 'Why', cell: (e) => GUARDRAIL_KIND_LABELS[e.kind] },
                        {
                            id: 'to',
                            header: 'To',
                            cell: (e) =>
                                e.personId ? (
                                    <Link to={paths.person(workspaceId, e.personId)}>{e.address ?? 'A person'}</Link>
                                ) : (
                                    (e.address ?? '—')
                                ),
                        },
                        { id: 'owner', header: 'Whose', cell: (e) => e.owner?.name ?? '—' },
                        {
                            id: 'detail',
                            header: 'Detail',
                            cell: (e) => <span className="text-xs text-text-muted">{e.message}</span>,
                        },
                        {
                            id: 'review',
                            header: 'Review',
                            cell: (e) =>
                                e.legitimate ? (
                                    <span className="text-xs text-text-muted">
                                        Legitimate ({e.legitimate.by?.name ?? 'a reviewer'}): {e.legitimate.reason}
                                    </span>
                                ) : (
                                    <Button size="sm" shape="square" onClick={() => setMarking(e)}>
                                        Mark legitimate
                                    </Button>
                                ),
                        },
                    ],
                }}
            />
            <MarkLegitimateDialog workspaceId={workspaceId} event={marking} onClose={() => setMarking(null)} />
            {editingPoaching && settings.data && (
                <GuardrailSettingsDialog
                    workspaceId={workspaceId}
                    settings={settings.data}
                    onClose={() => setEditingPoaching(false)}
                />
            )}
            {editingReputation && reputation.data && (
                <ReputationSettingsDialog
                    workspaceId={workspaceId}
                    settings={reputation.data}
                    onClose={() => setEditingReputation(false)}
                />
            )}
        </section>
    );
}

function MarkLegitimateDialog({
    workspaceId,
    event,
    onClose,
}: {
    workspaceId: string;
    event: GuardrailEventView | null;
    onClose: () => void;
}) {
    const mark = useMarkLegitimate(workspaceId);
    const [reason, setReason] = useState('');
    const close = () => {
        setReason('');
        onClose();
    };
    const submit = (e: FormEvent) => {
        e.preventDefault();
        if (!event) return;
        mark.mutate(
            { id: event.id, reason: reason.trim() },
            {
                onSuccess: () => {
                    toast({ tone: 'success', title: 'Marked legitimate' });
                    close();
                },
                onError: (err) => toast({ tone: 'danger', title: 'Not marked', description: failureText(err) }),
            },
        );
    };
    return (
        <Dialog open={event !== null} onOpenChange={(o) => !o && close()}>
            <DialogContent>
                <DialogTitle>Mark legitimate</DialogTitle>
                <DialogDescription>
                    Say why this was fine. The reason is kept with your name; the event stays on the list.
                </DialogDescription>
                <form onSubmit={submit}>
                    <DialogBody>
                        <Field label="Why" required>
                            <Textarea
                                value={reason}
                                maxLength={GUARDRAIL_REASON_MAX}
                                onChange={(e) => setReason(e.target.value)}
                            />
                        </Field>
                    </DialogBody>
                    <DialogFooter>
                        <Button type="button" onClick={close}>
                            Cancel
                        </Button>
                        <Button type="submit" variant="primary" loading={mark.isPending} disabled={!reason.trim()}>
                            Mark legitimate
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

import {
    Badge,
    Button,
    Dialog,
    DialogBody,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogTitle,
    FactGrid,
    Field,
    Input,
    Skeleton,
    StageProgress,
    cn,
    focusRing,
} from '@bylinecrm/ui';
import { useId, useMemo, useState } from 'react';
import { Link } from 'react-router';
import {
    useDealHistory,
    useMoveDeal,
    usePatchRecord,
    usePipeline,
    useRecord,
    useRecordList,
} from '../../../api/queries';
import type { OpportunityView, StageView } from '../../../api/types';
import { usePermission } from '../../../auth/capabilities';
import { formatDate, formatDay } from '../../../lib/format';
import { formatMoney, minorDigits, toMajor, toMinor } from '../../../lib/money';
import { paths } from '../../paths';
import { AttachmentsPanel } from './AttachmentsPanel';
import { InlineSelect, InlineText, messageFor } from './InlineEdit';
import { NotesPanel } from './NotesPanel';
import { personName, sourceLabel } from './PersonRecord';
import { OwnerControl, PropertiesColumn, type PropertyRow } from './PropertiesColumn';
import { RailCard, RailEmpty, RailLoading, RailRow } from './RailCard';
import { RecordHeader } from './RecordHeader';
import { RecordLayout } from './RecordLayout';
import { TasksPanel } from './TasksPanel';
import { TimelinePanel } from './TimelinePanel';
import { useRecordCommands } from './useRecordCommands';

/** The deal record: the stage bar across the top (click a stage to move; won/lost ask to close). */
export function DealRecord({
    workspaceId,
    deal,
    layout,
    siblings,
    membersById,
}: {
    workspaceId: string;
    deal: OpportunityView;
    layout: 'page' | 'drawer';
    siblings?: { prev: string | null; next: string | null } | undefined;
    membersById: ReadonlyMap<string, string>;
}) {
    const patch = usePatchRecord(workspaceId, 'opportunity', deal.id);
    const edit = usePermission('deal:edit');
    const move = usePermission('deal:move');
    const pipeline = usePipeline(workspaceId, deal.pipelineId);
    const moveDeal = useMoveDeal(workspaceId);
    const history = useDealHistory(workspaceId, deal.id);
    const company = useRecord(workspaceId, 'company', deal.companyId ?? '');
    const contact = useRecord(workspaceId, 'person', deal.pointOfContactId ?? '');
    const companies = useRecordList(workspaceId, 'company', { limit: 200 }, edit.allowed);
    const people = useRecordList(workspaceId, 'person', { limit: 200 }, edit.allowed);
    const [notesOpen, setNotesOpen] = useState(false);
    const [tasksOpen, setTasksOpen] = useState(false);
    const [closing, setClosing] = useState<StageView | null>(null);
    const ownerId = useId();
    const target = { type: 'opportunity' as const, id: deal.id };
    const save = (p: Record<string, unknown>) => patch.mutateAsync(p);

    useRecordCommands({
        layout,
        onNote: edit.allowed ? () => setNotesOpen(true) : undefined,
        onTask: edit.allowed ? () => setTasksOpen(true) : undefined,
        onOwner: edit.allowed ? () => document.getElementById(ownerId)?.focus() : undefined,
        prev: siblings?.prev,
        next: siblings?.next,
    });

    const stages = useMemo(
        () => [...(pipeline.data?.stages ?? [])].sort((a, b) => a.position - b.position),
        [pipeline.data],
    );
    const stageNames = useMemo(() => new Map(stages.map((s) => [s.id, s.name])), [stages]);
    const current = stages.findIndex((s) => s.id === deal.stageId);
    const currentStage = stages[current];

    const requestMove = (stage: StageView) => {
        if (stage.id === deal.stageId) return;
        if (stage.kind === 'won' || stage.kind === 'lost') {
            setClosing(stage);
            return;
        }
        moveDeal.mutate({ dealId: deal.id, pipelineId: deal.pipelineId, stageId: stage.id });
    };

    const standard: PropertyRow[] = [
        {
            field: 'name',
            control: (
                <InlineText
                    label="Name"
                    path="name"
                    value={deal.name}
                    canEdit={edit.allowed}
                    reason={edit.reason}
                    onSave={(v) => save({ name: v ?? '' })}
                />
            ),
        },
        {
            field: 'amount',
            control: (
                <InlineText
                    label={`Amount (${deal.currency})`}
                    path="amount"
                    type="number"
                    value={deal.amount ? toMajor(deal.amount).toFixed(minorDigits(deal.currency)) : null}
                    display={() => formatMoney(deal.amount)}
                    canEdit={edit.allowed}
                    reason={edit.reason}
                    onSave={(v) =>
                        save({
                            amount:
                                v === null
                                    ? null
                                    : { amountMinor: toMinor(Number(v), deal.currency), currency: deal.currency },
                        })
                    }
                />
            ),
        },
        {
            field: 'closeDate',
            control: (
                <InlineText
                    label="Close date"
                    path="closeDate"
                    type="date"
                    value={deal.closeDate}
                    display={(v) => formatDay(v)}
                    canEdit={edit.allowed}
                    reason={edit.reason}
                    onSave={(v) => save({ closeDate: v })}
                />
            ),
        },
        {
            field: 'probability',
            control: (
                <InlineText
                    label="Probability (%)"
                    path="probability"
                    type="number"
                    value={deal.probability === null ? null : String(deal.probability)}
                    display={(v) => `${v}%`}
                    canEdit={edit.allowed}
                    reason={edit.reason}
                    onSave={(v) => save({ probability: v === null ? null : Number(v) })}
                />
            ),
        },
        {
            field: 'ownerId',
            control: (
                <OwnerControl
                    workspaceId={workspaceId}
                    value={deal.ownerId}
                    onSave={(v) => save({ ownerId: v })}
                    id={ownerId}
                />
            ),
        },
        {
            field: 'companyId',
            control: (
                <InlineSelect
                    label="Company"
                    path="companyId"
                    value={deal.companyId}
                    options={(companies.data?.items ?? (company.data ? [company.data] : [])).map((c) => ({
                        value: c.id,
                        label: c.name,
                    }))}
                    clearLabel="No company"
                    canEdit={edit.allowed}
                    reason={edit.reason}
                    onSave={(v) => save({ companyId: v })}
                />
            ),
        },
        {
            field: 'pointOfContactId',
            control: (
                <InlineSelect
                    label="Point of contact"
                    path="pointOfContactId"
                    value={deal.pointOfContactId}
                    options={(people.data?.items ?? (contact.data ? [contact.data] : [])).map((p) => ({
                        value: p.id,
                        label: personName(p),
                    }))}
                    clearLabel="Nobody yet"
                    canEdit={edit.allowed}
                    reason={edit.reason}
                    onSave={(v) => save({ pointOfContactId: v })}
                />
            ),
        },
    ];

    const stageBar = pipeline.isPending ? (
        <Skeleton className="h-24" />
    ) : pipeline.isError || !currentStage ? (
        <p className="m-0 rounded-md bg-surface-raised px-3 py-2 text-[13px] text-text-muted">
            The pipeline could not be loaded; the deal is current.
        </p>
    ) : (
        <div>
            <StageProgress
                title={`${pipeline.data.name} · ${currentStage.name}`}
                meta={`${formatMoney(deal.amount)} · ${deal.daysInStage}d in stage${deal.closedAt ? ` · closed ${formatDay(deal.closedAt)}` : ''}`}
                stages={stages.map((s) => ({ label: s.name }))}
                current={current}
            />
            {move.allowed && (
                <div role="group" aria-label="Move to stage" className="mt-2 flex flex-wrap gap-1.5">
                    {stages.map((s) => (
                        <button
                            key={s.id}
                            type="button"
                            disabled={s.id === deal.stageId || moveDeal.isPending}
                            onClick={() => requestMove(s)}
                            className={cn(
                                'h-7 rounded-md border border-border px-2.5 text-xs font-medium text-text-muted hover:bg-surface-raised hover:text-text disabled:opacity-50 max-md:h-touch',
                                s.kind === 'won' && 'text-success',
                                s.kind === 'lost' && 'text-danger',
                                focusRing,
                            )}
                        >
                            {s.id === deal.stageId ? `In ${s.name}` : `Move to ${s.name}`}
                        </button>
                    ))}
                </div>
            )}
            {moveDeal.isError && (
                <p role="alert" className="m-0 mt-1.5 text-xs text-danger">
                    {messageFor(moveDeal.error, 'stageId')}
                </p>
            )}
            {moveDeal.data && moveDeal.data.rulesThatMayMoveItForward.length > 0 && (
                <p role="status" className="m-0 mt-1.5 text-xs text-text-muted">
                    Moved back. A rule may move it forward again on the next{' '}
                    {moveDeal.data.rulesThatMayMoveItForward.map((r) => r.event.replace(/\./g, ' ')).join(' or ')}.
                </p>
            )}
        </div>
    );

    return (
        <RecordLayout
            layout={layout}
            header={
                <RecordHeader
                    layout={layout}
                    name={deal.name}
                    subtitle={
                        <>
                            {deal.companyId && company.data && (
                                <Link
                                    to={paths.company(workspaceId, deal.companyId)}
                                    className="text-text underline decoration-border-strong underline-offset-2 hover:decoration-current"
                                >
                                    {company.data.name}
                                </Link>
                            )}
                            {deal.companyId && company.data && deal.amount ? ' · ' : ''}
                            {deal.amount ? formatMoney(deal.amount) : ''}
                        </>
                    }
                    status={
                        currentStage ? (
                            <Badge
                                status={
                                    currentStage.kind === 'won'
                                        ? 'success'
                                        : currentStage.kind === 'lost'
                                          ? 'danger'
                                          : 'accent'
                                }
                            >
                                {currentStage.name}
                            </Badge>
                        ) : undefined
                    }
                    back={{ to: paths.deals(workspaceId), label: 'Deals' }}
                    siblings={siblings}
                    actions={
                        <>
                            <Button
                                variant="secondary"
                                shape="square"
                                size="sm"
                                onClick={() => setNotesOpen(true)}
                                disabled={!edit.allowed}
                                title={edit.reason || 'Add a note (n)'}
                            >
                                Add note
                            </Button>
                            <Button
                                data-primary-action
                                variant="primary"
                                shape="square"
                                size="sm"
                                onClick={() => setTasksOpen(true)}
                                disabled={!edit.allowed}
                                title={edit.reason || 'Add a task (t)'}
                            >
                                Add task
                            </Button>
                        </>
                    }
                />
            }
            facts={
                <FactGrid
                    facts={[
                        { label: 'Owner', value: deal.ownerId ? (membersById.get(deal.ownerId) ?? '…') : 'Unassigned' },
                        { label: 'Close date', value: formatDay(deal.closeDate) },
                        { label: 'Probability', value: deal.probability === null ? '—' : `${deal.probability}%` },
                        {
                            label: 'Contact',
                            value: deal.pointOfContactId ? (contact.data ? personName(contact.data) : '…') : '—',
                        },
                    ]}
                />
            }
            properties={
                <PropertiesColumn
                    workspaceId={workspaceId}
                    object="opportunity"
                    custom={deal.custom}
                    standard={standard}
                    audit={{
                        createdAt: deal.createdAt,
                        updatedAt: deal.updatedAt,
                        createdBy: sourceLabel(deal.createdBy.kind),
                    }}
                    onSave={save}
                    canEdit={edit.allowed}
                    reason={edit.reason}
                />
            }
            rail={
                <>
                    <RailCard title="Stage history" count={history.data?.length}>
                        {history.isPending ? (
                            <RailLoading />
                        ) : history.isError || !history.data?.length ? (
                            <RailEmpty>No stage changes yet.</RailEmpty>
                        ) : (
                            history.data.map((h) => (
                                <RailRow
                                    key={h.id}
                                    title={`${h.fromStageId ? `${stageNames.get(h.fromStageId) ?? '…'} → ` : ''}${stageNames.get(h.toStageId) ?? '…'}`}
                                    subtitle={`${formatDate(h.enteredAt)} · ${h.reason === 'rule' ? 'by a rule' : h.reason}`}
                                />
                            ))
                        )}
                    </RailCard>
                    <RailCard title="Contact">
                        {deal.pointOfContactId && contact.data ? (
                            <RailRow
                                to={paths.person(workspaceId, deal.pointOfContactId)}
                                title={personName(contact.data)}
                                subtitle={contact.data.jobTitle ?? contact.data.emails.primary ?? undefined}
                            />
                        ) : (
                            <RailEmpty>No point of contact yet.</RailEmpty>
                        )}
                    </RailCard>
                    <TasksPanel
                        workspaceId={workspaceId}
                        target={target}
                        open={tasksOpen}
                        onOpenChange={setTasksOpen}
                    />
                    <NotesPanel
                        workspaceId={workspaceId}
                        target={target}
                        open={notesOpen}
                        onOpenChange={setNotesOpen}
                    />
                    <AttachmentsPanel workspaceId={workspaceId} target={target} />
                </>
            }
        >
            {stageBar}
            <TimelinePanel workspaceId={workspaceId} target={target} stageNames={stageNames} />
            {closing && (
                <CloseDialog
                    stage={closing}
                    deal={deal}
                    pending={moveDeal.isPending}
                    error={moveDeal.isError ? messageFor(moveDeal.error, 'close') : null}
                    onCancel={() => setClosing(null)}
                    onConfirm={(close) =>
                        moveDeal.mutate(
                            { dealId: deal.id, pipelineId: deal.pipelineId, stageId: closing.id, close },
                            { onSuccess: () => setClosing(null) },
                        )
                    }
                />
            )}
        </RecordLayout>
    );
}

/** Moving into Won or Lost asks for the close detail the API requires before anything moves. */
function CloseDialog({
    stage,
    deal,
    pending,
    error,
    onCancel,
    onConfirm,
}: {
    stage: StageView;
    deal: OpportunityView;
    pending: boolean;
    error: string | null;
    onCancel: () => void;
    onConfirm: (close: { wonAmount?: { amountMinor: number; currency: string }; lostReason?: string }) => void;
}) {
    const won = stage.kind === 'won';
    const [amount, setAmount] = useState(deal.amount ? toMajor(deal.amount).toFixed(minorDigits(deal.currency)) : '');
    const [reason, setReason] = useState('');
    return (
        <Dialog open onOpenChange={(o) => !o && onCancel()}>
            <DialogContent>
                <DialogTitle>{won ? 'Mark as won' : 'Mark as lost'}</DialogTitle>
                <DialogDescription>
                    {won
                        ? 'The won amount is recorded with the close.'
                        : 'The reason is kept on the deal and its history.'}
                </DialogDescription>
                <form
                    id="close-form"
                    onSubmit={(e) => {
                        e.preventDefault();
                        onConfirm(
                            won
                                ? {
                                      wonAmount: {
                                          amountMinor: toMinor(Number(amount || 0), deal.currency),
                                          currency: deal.currency,
                                      },
                                  }
                                : { lostReason: reason.trim() },
                        );
                    }}
                >
                    <DialogBody className="flex flex-col gap-3">
                        {won ? (
                            <Field label={`Won amount (${deal.currency})`} required>
                                <Input
                                    type="number"
                                    min={0}
                                    step="any"
                                    value={amount}
                                    onChange={(e) => setAmount(e.target.value)}
                                    autoFocus
                                />
                            </Field>
                        ) : (
                            <Field label="Lost reason" required>
                                <Input value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
                            </Field>
                        )}
                        {error && (
                            <p role="alert" className="m-0 text-sm text-danger">
                                {error}
                            </p>
                        )}
                    </DialogBody>
                </form>
                <DialogFooter>
                    <Button variant="secondary" shape="square" onClick={onCancel}>
                        Cancel
                    </Button>
                    <Button
                        type="submit"
                        form="close-form"
                        variant="primary"
                        shape="square"
                        disabled={pending || (won ? amount === '' : !reason.trim())}
                    >
                        {won ? 'Mark won' : 'Mark lost'}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

import { SEQUENCE_LIMITS } from '@bylinecrm/shared';
import {
    Badge,
    Button,
    Checkbox,
    DataTableChrome,
    EmptyState,
    Field,
    Input,
    LoadingRegion,
    PageHeader,
    RadioGroup,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    Switch,
    toast,
} from '@bylinecrm/ui';
import { ArrowDown, ArrowUp, Clock, ListTodo, Mail, Trash2 } from 'lucide-react';
import { useId, useMemo, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { usePipelines } from '../../../api/deals';
import {
    usePeopleNames,
    usePutSequenceSteps,
    useSequence,
    useSequenceEnrolments,
    useSequenceTransition,
    useUpdateSequence,
    type SequenceTransition,
} from '../../../api/sequences';
import { useTemplates } from '../../../api/templates';
import { VISIBILITY_LEGEND, VISIBILITY_OPTIONS } from './visibility';
import type { SequenceStepInput, SequenceView, SequenceWindow } from '../../../api/types';
import { useCan, useMembership, usePermission } from '../../../auth/capabilities';
import { ConfirmDialog } from '../../../components/ConfirmDialog';
import { failureText } from '../../../lib/errors';
import { trackingText } from '../../../lib/tracking';
import { formatWhen } from '../../../lib/format';
import { useWorkspaceId } from '../../params';
import { paths } from '../../paths';
import { EnrolDialog, enrolSummary } from './EnrolDialog';
import { enrolmentLine } from './PersonEnrolments';
import { StatusBadge } from './SequencesPage';
import {
    DAYS,
    describeWindow,
    ENROLMENT_STATUS_LABEL,
    ENROLMENT_STATUS_TONE,
    MANDATORY_STOPS,
    minuteToInput,
    timeToMinute,
    enrolmentTaskLine,
} from './sequenceText';

/** A step as the builder holds it: the saved id when it has one, and a key for the list. */
type DraftStep =
    | { key: string; id?: string; kind: 'email'; templateId: string | null; replyInThread: boolean }
    | { key: string; id?: string; kind: 'wait'; waitDays: number; businessDays: boolean }
    | { key: string; id?: string; kind: 'task'; taskTitle: string };

/** A new wait: three business days, the follow-up gap the wireframe draws. */
const NEW_WAIT_DAYS = 3;

let draftKey = 0;
const nextKey = () => `new-${(draftKey += 1)}`;

function toDraft(sequence: SequenceView): DraftStep[] {
    return sequence.steps.map((s): DraftStep => {
        switch (s.kind) {
            case 'email':
                return { key: s.id, id: s.id, kind: 'email', templateId: s.templateId, replyInThread: s.replyInThread };
            case 'wait':
                return {
                    key: s.id,
                    id: s.id,
                    kind: 'wait',
                    waitDays: s.waitDays ?? NEW_WAIT_DAYS,
                    businessDays: s.businessDays,
                };
            case 'task':
                return { key: s.id, id: s.id, kind: 'task', taskTitle: s.taskTitle ?? '' };
        }
    });
}

/** What the API takes: the step list in order; a saved step keeps its id so its enrolments keep their place. */
function toInput(steps: readonly DraftStep[]): SequenceStepInput[] {
    return steps.map((s) => {
        const id = s.id ? { id: s.id } : {};
        switch (s.kind) {
            case 'email':
                return { ...id, kind: 'email', templateId: s.templateId ?? '', replyInThread: s.replyInThread };
            case 'wait':
                return { ...id, kind: 'wait', waitDays: s.waitDays, businessDays: s.businessDays };
            case 'task':
                return { ...id, kind: 'task', taskTitle: s.taskTitle.trim() };
        }
    });
}

/**
 * One sequence (doc 50 §D): its steps, send window, stop conditions, counts and enrolments. A
 * member with `sequence:write` edits it; anyone with `sequence:enrol` sees it read-only and may
 * enrol people. Counts come from the enrolment rows, never a stored tally.
 */
export function SequencePage() {
    const workspaceId = useWorkspaceId();
    const { sequenceId = '' } = useParams();
    const sequence = useSequence(workspaceId, sequenceId);
    if (sequence.isError) throw sequence.error;
    if (!sequence.data) return <LoadingRegion label="Loading sequence" className="p-7 max-md:p-4" />;
    return <SequenceBuilder key={sequence.data.id} workspaceId={workspaceId} sequence={sequence.data} />;
}

function SequenceBuilder({ workspaceId, sequence }: { workspaceId: string; sequence: SequenceView }) {
    const write = usePermission('sequence:write');
    const canEnrol = useCan('sequence:enrol');
    const editable = write.allowed && sequence.status !== 'archived';
    const transition = useSequenceTransition(workspaceId, sequence.id);
    const [archiving, setArchiving] = useState(false);
    const [enrolling, setEnrolling] = useState(false);
    const pipelines = usePipelines(workspaceId);
    const pipelineName = (pipelines.data ?? []).find((p) => p.id === sequence.pipelineId)?.name;

    const run = (action: SequenceTransition, done: string) =>
        transition.mutate(action, {
            onSuccess: () => toast({ title: done }),
            onError: (e) =>
                toast({ title: 'The sequence did not change', description: failureText(e), tone: 'danger' }),
        });
    const hasEmail = sequence.steps.some((s) => s.kind === 'email');

    return (
        <div className="flex flex-col gap-6 p-7 max-md:p-4">
            <PageHeader
                title={sequence.name}
                subtitle={
                    sequence.pipelineId
                        ? `Pipeline: ${pipelineName ?? '…'}${sequence.stopOnPipelineExit ? ' · Stops when a deal leaves this pipeline' : ''}`
                        : 'Not tied to a pipeline'
                }
                chip={<StatusBadge status={sequence.status} />}
                actions={
                    <div className="flex flex-wrap items-center gap-2">
                        {write.allowed && sequence.status === 'draft' && (
                            <Button
                                shape="square"
                                disabled={!hasEmail}
                                title={hasEmail ? undefined : 'Add an email step first'}
                                loading={transition.isPending}
                                onClick={() => run('activate', 'Sequence activated')}
                            >
                                Activate
                            </Button>
                        )}
                        {write.allowed && sequence.status === 'active' && (
                            <Button
                                shape="square"
                                loading={transition.isPending}
                                onClick={() => run('pause', 'Sequence paused')}
                            >
                                Pause
                            </Button>
                        )}
                        {write.allowed && sequence.status === 'paused' && (
                            <Button
                                shape="square"
                                loading={transition.isPending}
                                onClick={() => run('resume', 'Sequence resumed')}
                            >
                                Resume
                            </Button>
                        )}
                        {write.allowed && sequence.status !== 'archived' && (
                            <Button shape="square" variant="ghost" onClick={() => setArchiving(true)}>
                                Archive
                            </Button>
                        )}
                        {canEnrol && sequence.status !== 'archived' && (
                            <Button
                                data-primary-action
                                variant="primary"
                                shape="square"
                                onClick={() => setEnrolling(true)}
                            >
                                Enrol people
                            </Button>
                        )}
                    </div>
                }
            />

            <StepsCard workspaceId={workspaceId} sequence={sequence} editable={editable} />
            <SettingsCard workspaceId={workspaceId} sequence={sequence} editable={editable} />
            <VisibilityCard workspaceId={workspaceId} sequence={sequence} />
            <EnrolmentsCard workspaceId={workspaceId} sequence={sequence} />

            {enrolling && (
                <EnrolDialog
                    workspaceId={workspaceId}
                    sequenceId={sequence.id}
                    people={[]}
                    onOpenChange={(open) => !open && setEnrolling(false)}
                    onDone={(result) => {
                        setEnrolling(false);
                        toast({ title: enrolSummary(result) });
                    }}
                />
            )}
            <ConfirmDialog
                open={archiving}
                onOpenChange={(open) => !open && setArchiving(false)}
                title={`Archive “${sequence.name}”?`}
                body="It becomes read-only and every active enrolment stops with the reason “sequence archived”."
                confirm="Archive"
                pending={transition.isPending}
                onConfirm={() =>
                    transition.mutate('archive', {
                        onSuccess: () => {
                            setArchiving(false);
                            toast({ title: 'Sequence archived' });
                        },
                    })
                }
            />
        </div>
    );
}

function Card({ title, children, footer }: { title: string; children: ReactNode; footer?: ReactNode }) {
    return (
        <section className="rounded-lg border border-border bg-surface shadow-sm">
            <h2 className="m-0 border-b border-border px-4 py-3 text-sm font-medium">{title}</h2>
            <div className="flex flex-col gap-3 p-4">{children}</div>
            {footer && (
                <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-3">{footer}</div>
            )}
        </section>
    );
}

function StepsCard({
    workspaceId,
    sequence,
    editable,
}: {
    workspaceId: string;
    sequence: SequenceView;
    editable: boolean;
}) {
    const templates = useTemplates(workspaceId, { kind: 'outreach' });
    const outreach = useMemo(() => templates.data?.pages.flatMap((p) => p.items) ?? [], [templates.data]);
    // #192: a Personal template cannot send from a sequence (no unsubscribe footer); it is shown, unusable,
    // so a template that "does not appear" explains itself.
    const personalTemplates = useTemplates(workspaceId, { kind: 'personal' });
    const personal = useMemo(
        () => personalTemplates.data?.pages.flatMap((p) => p.items) ?? [],
        [personalTemplates.data],
    );
    const noOutreach = templates.isSuccess && outreach.length === 0;
    const nameOf = new Map(outreach.map((t) => [t.id, t.name]));
    const put = usePutSequenceSteps(workspaceId, sequence.id);
    // An untouched builder shows the saved steps, so a save (or another member's) is followed;
    // the first edit takes a draft, which a save clears again.
    const [draft, setDraft] = useState<DraftStep[] | null>(null);
    const saved = useMemo(() => toDraft(sequence), [sequence]);
    const steps = draft ?? saved;
    // What each saved email step's sends did (P3-4): read from the sequence, never from the draft.
    const trackingOf = useMemo(
        () => new Map(sequence.steps.filter((s) => s.kind === 'email').map((s) => [s.id, s.tracking])),
        [sequence.steps],
    );
    const dirty = draft !== null;
    const change = (next: DraftStep[]) => setDraft(next);
    const update = (index: number, patch: Partial<DraftStep>) =>
        change(steps.map((s, i) => (i === index ? ({ ...s, ...patch } as DraftStep) : s)));
    const move = (index: number, by: -1 | 1) => {
        const next = [...steps];
        const [step] = next.splice(index, 1);
        next.splice(index + by, 0, step!);
        change(next);
    };
    const add = (kind: DraftStep['kind']) =>
        change([
            ...steps,
            kind === 'email'
                ? { key: nextKey(), kind, templateId: null, replyInThread: false }
                : kind === 'wait'
                  ? { key: nextKey(), kind, waitDays: NEW_WAIT_DAYS, businessDays: true }
                  : { key: nextKey(), kind, taskTitle: '' },
        ]);
    const complete =
        steps.length > 0 &&
        steps.every((s) =>
            s.kind === 'email' ? s.templateId !== null : s.kind === 'task' ? s.taskTitle.trim() !== '' : true,
        );
    const full = steps.length >= SEQUENCE_LIMITS.steps;
    // Each email step's number among the emails, computed once per render ("Email 2" is the first follow-up).
    const emailNumbers = steps.map((_, i) => steps.slice(0, i + 1).filter((s) => s.kind === 'email').length);

    const save = () =>
        put.mutate(
            { steps: toInput(steps) },
            {
                onSuccess: () => {
                    setDraft(null);
                    toast({
                        title: 'Steps saved',
                        description:
                            sequence.status === 'draft'
                                ? undefined
                                : 'People past a changed step are untouched; the change applies to those who have not reached it.',
                    });
                },
            },
        );

    return (
        <Card
            title="Steps"
            footer={
                editable ? (
                    <>
                        <Button size="sm" variant="ghost" disabled={full} onClick={() => add('email')}>
                            <Mail aria-hidden /> Add email
                        </Button>
                        <Button size="sm" variant="ghost" disabled={full} onClick={() => add('task')}>
                            <ListTodo aria-hidden /> Add task
                        </Button>
                        <Button size="sm" variant="ghost" disabled={full} onClick={() => add('wait')}>
                            <Clock aria-hidden /> Add wait
                        </Button>
                        <Button
                            className="ml-auto"
                            size="sm"
                            variant="primary"
                            disabled={!dirty || !complete}
                            title={complete ? undefined : 'Choose a template for every email step and title every task'}
                            loading={put.isPending}
                            onClick={save}
                        >
                            Save steps
                        </Button>
                    </>
                ) : undefined
            }
        >
            {put.isError && (
                <p role="alert" className="m-0 text-sm text-danger">
                    {failureText(put.error)}
                </p>
            )}
            {editable && noOutreach && (
                <p className="m-0 rounded-md bg-surface-raised px-3 py-2 text-[13px] text-text-muted">
                    No outreach template yet. A sequence sends only Outreach templates — they end with the unsubscribe
                    link and your postal address. Open a template and set its kind to Outreach.{' '}
                    <Link to={paths.templates(workspaceId)} className="text-accent underline-offset-2 hover:underline">
                        Open Templates
                    </Link>
                </p>
            )}
            {steps.length === 0 ? (
                <EmptyState
                    title="No steps yet"
                    body="Add an email from an outreach template, then waits between the follow-ups."
                />
            ) : (
                <ol aria-label="Steps" className="m-0 flex list-none flex-col gap-2 p-0">
                    {steps.map((step, index) => {
                        const label = `step ${index + 1}`;
                        const emailNumber = emailNumbers[index] ?? 0;
                        return (
                            <li
                                key={step.key}
                                className="flex flex-wrap items-center gap-3 rounded-md border border-border px-3 py-2"
                            >
                                {step.kind === 'email' ? (
                                    <>
                                        <Mail aria-hidden className="size-4 text-text-muted" />
                                        <span className="text-sm font-medium">Email {emailNumber}</span>
                                        {editable ? (
                                            <Select
                                                value={step.templateId ?? ''}
                                                onValueChange={(templateId) => update(index, { templateId })}
                                            >
                                                <SelectTrigger
                                                    aria-label={`Template for ${label}`}
                                                    className="min-w-56 max-md:w-full"
                                                >
                                                    <SelectValue placeholder="Choose an outreach template" />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    {outreach.map((t) => (
                                                        <SelectItem key={t.id} value={t.id}>
                                                            {t.name}
                                                        </SelectItem>
                                                    ))}
                                                    {personal.map((t) => (
                                                        <SelectItem key={t.id} value={t.id} disabled>
                                                            {t.name} — Personal
                                                        </SelectItem>
                                                    ))}
                                                </SelectContent>
                                            </Select>
                                        ) : (
                                            <span className="text-sm">
                                                {step.templateId ? (
                                                    <Link
                                                        className="hover:underline"
                                                        to={paths.template(workspaceId, step.templateId)}
                                                    >
                                                        {nameOf.get(step.templateId) ?? 'Template'}
                                                    </Link>
                                                ) : (
                                                    '—'
                                                )}
                                            </span>
                                        )}
                                        {step.id && trackingOf.has(step.id) && (
                                            <span className="text-xs text-text-muted">
                                                {trackingText(trackingOf.get(step.id)!)}
                                            </span>
                                        )}
                                        {emailNumber > 1 && (
                                            <InlineSwitch
                                                label="Reply in thread"
                                                checked={step.replyInThread}
                                                disabled={!editable}
                                                onChange={(replyInThread) => update(index, { replyInThread })}
                                            />
                                        )}
                                    </>
                                ) : step.kind === 'task' ? (
                                    <>
                                        <ListTodo aria-hidden className="size-4 text-text-muted" />
                                        <span className="text-sm font-medium">Task</span>
                                        <Input
                                            aria-label={`Task title, ${label}`}
                                            className="min-w-56 flex-1 max-md:w-full"
                                            maxLength={SEQUENCE_LIMITS.taskTitle}
                                            placeholder="Call if no reply"
                                            disabled={!editable}
                                            value={step.taskTitle}
                                            onChange={(e) => update(index, { taskTitle: e.target.value })}
                                        />
                                        <span className="text-sm text-text-muted">
                                            due when this step runs → person&rsquo;s owner
                                        </span>
                                    </>
                                ) : (
                                    <>
                                        <Clock aria-hidden className="size-4 text-text-muted" />
                                        <span className="text-sm">Wait</span>
                                        <Input
                                            aria-label={`Days to wait, ${label}`}
                                            type="number"
                                            inputMode="numeric"
                                            className="w-20"
                                            min={SEQUENCE_LIMITS.waitDays.min}
                                            max={SEQUENCE_LIMITS.waitDays.max}
                                            disabled={!editable}
                                            value={step.waitDays}
                                            onChange={(e) =>
                                                update(index, {
                                                    waitDays: Math.min(
                                                        SEQUENCE_LIMITS.waitDays.max,
                                                        Math.max(
                                                            SEQUENCE_LIMITS.waitDays.min,
                                                            Number(e.target.value) || 1,
                                                        ),
                                                    ),
                                                })
                                            }
                                        />
                                        <span className="text-sm">{step.businessDays ? 'business days' : 'days'}</span>
                                        <InlineSwitch
                                            label="Business days only"
                                            checked={step.businessDays}
                                            disabled={!editable}
                                            onChange={(businessDays) => update(index, { businessDays })}
                                        />
                                    </>
                                )}
                                {editable && (
                                    <span className="ml-auto flex gap-1">
                                        <Button
                                            size="icon"
                                            variant="ghost"
                                            aria-label={`Move ${label} up`}
                                            disabled={index === 0}
                                            onClick={() => move(index, -1)}
                                        >
                                            <ArrowUp aria-hidden />
                                        </Button>
                                        <Button
                                            size="icon"
                                            variant="ghost"
                                            aria-label={`Move ${label} down`}
                                            disabled={index === steps.length - 1}
                                            onClick={() => move(index, 1)}
                                        >
                                            <ArrowDown aria-hidden />
                                        </Button>
                                        <Button
                                            size="icon"
                                            variant="ghost"
                                            aria-label={`Remove ${label}`}
                                            onClick={() => change(steps.filter((_, i) => i !== index))}
                                        >
                                            <Trash2 aria-hidden />
                                        </Button>
                                    </span>
                                )}
                            </li>
                        );
                    })}
                </ol>
            )}
        </Card>
    );
}

function InlineSwitch({
    label,
    checked,
    disabled,
    onChange,
}: {
    label: string;
    checked: boolean;
    disabled: boolean;
    onChange: (checked: boolean) => void;
}) {
    const id = useId();
    return (
        <span className="flex items-center gap-2 text-sm max-md:min-h-touch">
            <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onChange} />
            <label htmlFor={id}>{label}</label>
        </span>
    );
}

/**
 * Who sees the sequence (#192): its owner or an admin chooses, and the choice saves at once; anyone
 * else reads it. Archived sequences keep what they had.
 */
function VisibilityCard({ workspaceId, sequence }: { workspaceId: string; sequence: SequenceView }) {
    const membership = useMembership();
    const admin = useCan('workspace:admin');
    const update = useUpdateSequence(workspaceId, sequence.id);
    const mine = membership?.memberId !== undefined && membership.memberId === sequence.ownerMemberId;
    const may = (admin || mine) && sequence.status !== 'archived';
    return (
        <Card title={VISIBILITY_LEGEND}>
            {may ? (
                <RadioGroup
                    legend={VISIBILITY_LEGEND}
                    className="[&>legend]:sr-only"
                    options={VISIBILITY_OPTIONS}
                    value={sequence.visibility}
                    disabled={update.isPending}
                    onValueChange={(visibility) =>
                        update.mutate(
                            { visibility },
                            {
                                onSuccess: () =>
                                    toast({
                                        title: visibility === 'private' ? 'Only you and admins see it now' : 'Shared',
                                    }),
                            },
                        )
                    }
                />
            ) : (
                <p className="m-0 text-sm text-text-muted">
                    {sequence.visibility === 'private'
                        ? 'Private: only its owner and the workspace’s admins see it.'
                        : 'Shared with everyone who runs outreach. Its owner or an admin can make it private.'}
                </p>
            )}
            {update.isError && (
                <p role="alert" className="m-0 text-sm text-danger">
                    {failureText(update.error)}
                </p>
            )}
        </Card>
    );
}

function SettingsCard({
    workspaceId,
    sequence,
    editable,
}: {
    workspaceId: string;
    sequence: SequenceView;
    editable: boolean;
}) {
    const update = useUpdateSequence(workspaceId, sequence.id);
    const [window, setWindow] = useState<SequenceWindow>(sequence.window);
    const [timeZone, setTimeZone] = useState(sequence.timeZone);
    const [stopOnExit, setStopOnExit] = useState(sequence.stopOnPipelineExit);
    const dirty =
        window.startMinute !== sequence.window.startMinute ||
        window.endMinute !== sequence.window.endMinute ||
        window.days !== sequence.window.days ||
        timeZone !== sequence.timeZone ||
        stopOnExit !== sequence.stopOnPipelineExit;
    const valid = window.endMinute > window.startMinute && window.days > 0 && timeZone.trim() !== '';
    const exitId = useId();
    const viewerZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

    return (
        <Card
            title="Send window and stop conditions"
            footer={
                editable ? (
                    <Button
                        size="sm"
                        variant="primary"
                        className="ml-auto"
                        disabled={!dirty || !valid}
                        loading={update.isPending}
                        onClick={() =>
                            update.mutate(
                                { window, timeZone: timeZone.trim(), stopOnPipelineExit: stopOnExit },
                                { onSuccess: () => toast({ title: 'Settings saved' }) },
                            )
                        }
                    >
                        Save settings
                    </Button>
                ) : undefined
            }
        >
            {update.isError && (
                <p role="alert" className="m-0 text-sm text-danger">
                    {failureText(update.error)}
                </p>
            )}
            <p className="m-0 text-sm">
                Sends {describeWindow(window)}, in each recipient&rsquo;s local time.
                <span className="block text-xs text-text-muted">
                    When a recipient&rsquo;s zone cannot be told, {timeZone} is used. You are in {viewerZone}.
                </span>
            </p>
            {editable && (
                <div className="flex flex-wrap items-end gap-3">
                    <Field label="From">
                        <Input
                            type="time"
                            value={minuteToInput(window.startMinute)}
                            onChange={(e) => {
                                const m = timeToMinute(e.target.value);
                                if (m !== null) setWindow({ ...window, startMinute: m });
                            }}
                        />
                    </Field>
                    <Field label="Until">
                        <Input
                            type="time"
                            value={minuteToInput(window.endMinute)}
                            onChange={(e) => {
                                const m = timeToMinute(e.target.value);
                                if (m !== null) setWindow({ ...window, endMinute: m });
                            }}
                        />
                    </Field>
                    <Field label="Fallback time zone">
                        <Input value={timeZone} maxLength={64} onChange={(e) => setTimeZone(e.target.value)} />
                    </Field>
                    <fieldset className="m-0 flex flex-wrap gap-2 border-0 p-0">
                        <legend className="mb-1.5 text-[13px] font-medium">Days</legend>
                        {DAYS.map((d) => {
                            const id = `${exitId}-day-${d.bit}`;
                            const on = (window.days & (1 << d.bit)) !== 0;
                            return (
                                <span key={d.bit} className="flex items-center gap-1.5 text-sm max-md:min-h-touch">
                                    <Checkbox
                                        id={id}
                                        checked={on}
                                        onCheckedChange={() =>
                                            setWindow({ ...window, days: window.days ^ (1 << d.bit) })
                                        }
                                    />
                                    <label htmlFor={id}>{d.name}</label>
                                </span>
                            );
                        })}
                    </fieldset>
                </div>
            )}
            {!valid && editable && (
                <p role="alert" className="m-0 text-xs text-danger">
                    The window must end after it starts, on at least one day, with a time zone.
                </p>
            )}
            <fieldset className="m-0 grid gap-2 border-0 p-0 sm:grid-cols-2">
                <legend className="mb-1.5 text-[13px] font-medium">
                    Stops when any of these happens (checked before every step)
                </legend>
                {MANDATORY_STOPS.map((name) => {
                    const id = `${exitId}-${name}`;
                    return (
                        <span key={name} className="flex items-center gap-2 text-sm max-md:min-h-touch">
                            <Checkbox id={id} checked disabled />
                            <label htmlFor={id}>{name}</label>
                        </span>
                    );
                })}
                <span className="flex items-center gap-2 text-sm max-md:min-h-touch">
                    <Checkbox
                        id={`${exitId}-exit`}
                        checked={sequence.pipelineId ? stopOnExit : false}
                        disabled={!editable || !sequence.pipelineId}
                        onCheckedChange={(v) => setStopOnExit(v === true)}
                    />
                    <label htmlFor={`${exitId}-exit`}>Deal leaves pipeline</label>
                </span>
            </fieldset>
            <p className="m-0 text-xs text-text-muted">
                The first six are always on; the server refuses turning them off. &ldquo;Deal leaves pipeline&rdquo;
                applies when the sequence is tied to a pipeline.
            </p>
        </Card>
    );
}

function EnrolmentsCard({ workspaceId, sequence }: { workspaceId: string; sequence: SequenceView }) {
    const canEnrol = useCan('sequence:enrol');
    const enrolments = useSequenceEnrolments(workspaceId, sequence.id);
    const rows = enrolments.data ?? [];
    const names = usePeopleNames(
        workspaceId,
        rows.map((e) => e.personId),
    );
    const c = sequence.counts;
    if (!canEnrol) return null;
    return (
        <section aria-label="Enrolments" className="flex flex-col gap-3">
            <p className="m-0 text-sm text-text-muted">
                Enrolled {c.enrolled} · Active {c.active} · Held {c.held} · Finished {c.finished} · Stopped {c.stopped}
            </p>
            <DataTableChrome
                data={{
                    label: 'Enrolments',
                    loading: enrolments.isPending,
                    rows,
                    getRowId: (e) => e.id,
                    empty: (
                        <EmptyState
                            className="m-4"
                            title="Nobody enrolled yet"
                            body="Enrol people from here, a person's page or a selection on the People list."
                        />
                    ),
                    columns: [
                        {
                            id: 'person',
                            header: 'Person',
                            className: 'font-medium',
                            cell: (e) => (
                                <Link
                                    to={paths.person(workspaceId, e.personId)}
                                    className="hover:underline max-md:flex max-md:min-h-touch max-md:items-center"
                                >
                                    {names.data?.get(e.personId) ?? '…'}
                                </Link>
                            ),
                        },
                        {
                            id: 'status',
                            header: 'Status',
                            phone: 'meta',
                            cell: (e) => (
                                <Badge status={ENROLMENT_STATUS_TONE[e.status]}>
                                    {ENROLMENT_STATUS_LABEL[e.status]}
                                </Badge>
                            ),
                        },
                        {
                            id: 'where',
                            header: 'Where',
                            muted: true,
                            phone: 'secondary',
                            cell: (e) =>
                                e.tasks.length === 0 ? (
                                    enrolmentLine(e)
                                ) : (
                                    <span className="flex flex-col gap-0.5">
                                        <span>{enrolmentLine(e)}</span>
                                        {e.tasks.map((task) => (
                                            <span key={task.id}>{enrolmentTaskLine(task)}</span>
                                        ))}
                                    </span>
                                ),
                        },
                        { id: 'enrolled', header: 'Enrolled', muted: true, cell: (e) => formatWhen(e.enrolledAt) },
                    ],
                }}
            />
        </section>
    );
}

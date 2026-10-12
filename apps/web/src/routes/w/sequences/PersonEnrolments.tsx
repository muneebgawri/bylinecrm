import { SEQUENCE_LIMITS } from '@bylinecrm/shared';
import { Badge, Button, Field, Textarea, toast } from '@bylinecrm/ui';
import { useState } from 'react';
import { Link } from 'react-router';
import {
    usePersonEnrolments,
    useReenrol,
    useResumeEnrolment,
    useSequences,
    useStopEnrolment,
} from '../../../api/sequences';
import type { SequenceEnrolmentView } from '../../../api/types';
import { useCan } from '../../../auth/capabilities';
import { ConfirmDialog } from '../../../components/ConfirmDialog';
import { failureText } from '../../../lib/errors';
import { formatWhen } from '../../../lib/format';
import { paths } from '../../paths';
import { RailCard, RailEmpty, RailLoading } from '../records/RailCard';
import { ENROLMENT_STATUS_LABEL, ENROLMENT_STATUS_TONE, STOP_REASON_LABEL, enrolmentTaskLine } from './sequenceText';

/** Where an enrolment stands, in one line: the step it is on, why it is held, or why it stopped. */
export function enrolmentLine(e: SequenceEnrolmentView): string {
    switch (e.status) {
        case 'active':
            return e.nextRunAt
                ? `Step ${e.stepIndex + 1} · next ${formatWhen(e.nextRunAt)}`
                : `Step ${e.stepIndex + 1}`;
        case 'held':
            return e.heldReason ? `Held: ${e.heldReason}` : 'Held';
        case 'finished':
            return 'Finished every step';
        case 'stopped':
            return e.stopReason ? `Stopped: ${STOP_REASON_LABEL[e.stopReason]}` : 'Stopped';
    }
}

/**
 * A person's sequences on their record (doc 50 §D, "owed": the per-person enrolment view): each
 * enrolment's state, with Stop, Resume and Re-enrol for a member allowed to enrol. Re-enrolling
 * after a stop is this explicit action only — enrolling again from a list skips the person.
 */
export function PersonEnrolments({ workspaceId, personId }: { workspaceId: string; personId: string }) {
    const canEnrol = useCan('sequence:enrol');
    const enrolments = usePersonEnrolments(workspaceId, personId, canEnrol);
    const sequences = useSequences(workspaceId, canEnrol);
    const stop = useStopEnrolment(workspaceId);
    const resume = useResumeEnrolment(workspaceId);
    const reenrol = useReenrol(workspaceId);
    const [stopping, setStopping] = useState<SequenceEnrolmentView | null>(null);
    const [note, setNote] = useState('');
    if (!canEnrol) return null;

    const nameOf = new Map((sequences.data ?? []).map((s) => [s.id, s.name]));
    const rows = enrolments.data ?? [];
    const failed = (title: string) => (error: unknown) =>
        toast({ title, description: failureText(error), tone: 'danger' });

    return (
        <RailCard title="Sequences" count={enrolments.data ? rows.length : undefined}>
            {enrolments.isPending ? (
                <RailLoading />
            ) : rows.length === 0 ? (
                <RailEmpty>Not in any sequence.</RailEmpty>
            ) : (
                <ul className="m-0 list-none divide-y divide-border p-0">
                    {rows.map((e) => (
                        <li key={e.id} className="flex flex-col gap-1.5 px-4 py-3 text-sm">
                            <div className="flex items-center gap-2">
                                <Link
                                    to={paths.sequence(workspaceId, e.sequenceId)}
                                    className="min-w-0 truncate font-medium hover:underline max-md:min-h-touch max-md:content-center"
                                >
                                    {nameOf.get(e.sequenceId) ?? 'Sequence'}
                                </Link>
                                <Badge className="ml-auto" status={ENROLMENT_STATUS_TONE[e.status]}>
                                    {ENROLMENT_STATUS_LABEL[e.status]}
                                </Badge>
                            </div>
                            <span className="text-xs text-text-muted">{enrolmentLine(e)}</span>
                            {e.tasks.map((task) => (
                                <span key={task.id} className="text-xs text-text-muted">
                                    {enrolmentTaskLine(task)}
                                </span>
                            ))}
                            <div className="flex flex-wrap gap-2">
                                {(e.status === 'active' || e.status === 'held') && (
                                    <Button size="sm" variant="ghost" onClick={() => setStopping(e)}>
                                        Stop
                                    </Button>
                                )}
                                {e.status === 'held' && (
                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        loading={resume.isPending && resume.variables === e.id}
                                        onClick={() =>
                                            resume.mutate(e.id, {
                                                onSuccess: () => toast({ title: 'Enrolment resumed' }),
                                                onError: failed('The enrolment was not resumed'),
                                            })
                                        }
                                    >
                                        Resume
                                    </Button>
                                )}
                                {e.status === 'stopped' && (
                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        loading={reenrol.isPending && reenrol.variables === e.id}
                                        onClick={() =>
                                            reenrol.mutate(e.id, {
                                                onSuccess: () => toast({ title: 'Re-enrolled from step 1' }),
                                                onError: failed('The person was not re-enrolled'),
                                            })
                                        }
                                    >
                                        Re-enrol
                                    </Button>
                                )}
                            </div>
                        </li>
                    ))}
                </ul>
            )}
            <ConfirmDialog
                open={stopping !== null}
                onOpenChange={(open) => {
                    if (!open) {
                        setStopping(null);
                        setNote('');
                        stop.reset();
                    }
                }}
                title={`Stop “${stopping ? (nameOf.get(stopping.sequenceId) ?? 'this sequence') : ''}” for this person?`}
                body="No further step is sent. You can re-enrol them from step 1 later."
                confirm="Stop enrolment"
                pending={stop.isPending}
                error={stop.isError ? failureText(stop.error) : undefined}
                onConfirm={() => {
                    if (!stopping) return;
                    stop.mutate(
                        { id: stopping.id, note: note.trim() || undefined },
                        {
                            onSuccess: () => {
                                toast({ title: 'Enrolment stopped' });
                                setStopping(null);
                                setNote('');
                            },
                        },
                    );
                }}
            >
                <Field label="Note" hint="Optional; kept with the stop.">
                    <Textarea
                        value={note}
                        maxLength={SEQUENCE_LIMITS.stopNote}
                        onChange={(e) => setNote(e.target.value)}
                    />
                </Field>
            </ConfirmDialog>
        </RailCard>
    );
}

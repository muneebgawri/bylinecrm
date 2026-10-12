import { SEQUENCE_LIMITS } from '@bylinecrm/shared';
import {
    Button,
    Dialog,
    DialogBody,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogTitle,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    Skeleton,
} from '@bylinecrm/ui';
import { useEffect, useMemo, useState } from 'react';
import { usePreviewEnrol, useEnrol, useSequences } from '../../../api/sequences';
import type { EnrolmentBatchView } from '../../../api/types';
import { RecordPicker } from '../../../components/RecordPicker';
import { failureText } from '../../../lib/errors';

/** A person the dialog shows by name; the caller already holds the names, so the dialog fetches none. */
export interface EnrolPerson {
    id: string;
    name: string;
    email: string | null;
}

/**
 * A non-blocking note about one person (`region.unknown`, D-251, #142): enrolled, and flagged for
 * review. Read only when the server sends `warnings`; until then a preview simply has none.
 */
interface EnrolWarning {
    personId: string;
    code: string;
    message: string;
}

function warningsOf(result: EnrolmentBatchView): readonly EnrolWarning[] {
    const extra = result as EnrolmentBatchView & { warnings?: readonly EnrolWarning[] };
    return extra.warnings ?? [];
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Enrols people in a sequence (doc 50 §D). Nothing is enrolled until the member confirms: the dialog
 * first asks the server what enrolling would do, and lists every person it would refuse with the
 * server's reason — never a guess. The confirm count is the server's; the enrol request recomputes it.
 * From a person or a selection the people are fixed; from a sequence the member adds them here.
 */
export function EnrolDialog({
    workspaceId,
    people: initial,
    sequenceId: fixedSequence,
    onOpenChange,
    onDone,
}: {
    workspaceId: string;
    people: readonly EnrolPerson[];
    /** Set when opened from a sequence: the sequence is not a choice. */
    sequenceId?: string | undefined;
    onOpenChange: (open: boolean) => void;
    onDone: (result: EnrolmentBatchView) => void;
}) {
    const sequences = useSequences(workspaceId, fixedSequence === undefined);
    const [sequenceId, setSequenceId] = useState<string | undefined>(fixedSequence);
    const [people, setPeople] = useState<readonly EnrolPerson[]>(initial);
    const preview = usePreviewEnrol(workspaceId, sequenceId ?? '');
    const enrol = useEnrol(workspaceId, sequenceId ?? '');
    const ids = useMemo(() => people.map((p) => p.id), [people]);
    const names = useMemo(() => new Map(people.map((p) => [p.id, p])), [people]);
    const choosable = (sequences.data ?? []).filter((s) => s.status !== 'archived');
    const { mutate: runPreview, reset: resetPreview } = preview;

    // Each change of sequence or people asks the server again; a stale answer is never shown.
    useEffect(() => {
        resetPreview();
        if (sequenceId && ids.length > 0) runPreview({ personIds: ids });
    }, [sequenceId, ids, runPreview, resetPreview]);

    const result = preview.data;
    const warnings = result ? warningsOf(result) : [];
    const count = result?.enrolled.length ?? 0;
    const confirm = () => {
        if (!sequenceId) return;
        enrol.mutate({ personIds: ids }, { onSuccess: onDone });
    };

    return (
        <Dialog open onOpenChange={onOpenChange}>
            <DialogContent className="max-w-xl">
                <DialogTitle>Enrol in a sequence</DialogTitle>
                <DialogDescription>
                    {plural(people.length, 'person', 'people')} selected. Nobody is enrolled until you confirm.
                </DialogDescription>
                <DialogBody className="flex flex-col gap-4">
                    {fixedSequence === undefined && (
                        <Select value={sequenceId ?? ''} onValueChange={setSequenceId}>
                            <SelectTrigger aria-label="Sequence">
                                <SelectValue placeholder="Choose a sequence" />
                            </SelectTrigger>
                            <SelectContent>
                                {choosable.map((s) => (
                                    <SelectItem key={s.id} value={s.id}>
                                        {s.name}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    )}
                    {fixedSequence !== undefined && (
                        <RecordPicker
                            workspaceId={workspaceId}
                            object="person"
                            value={null}
                            label="Add a person"
                            placeholder="Find a person…"
                            onChange={() => undefined}
                            onResolved={(id, title) =>
                                setPeople((current) =>
                                    current.some((p) => p.id === id) || current.length >= SEQUENCE_LIMITS.enrolBatch
                                        ? current
                                        : [...current, { id, name: title, email: null }],
                                )
                            }
                        />
                    )}
                    {preview.isPending && <Skeleton className="h-24 w-full" />}
                    {preview.isError && (
                        <p role="alert" className="m-0 text-sm text-danger">
                            {failureText(preview.error)}
                        </p>
                    )}
                    {result && (
                        <div className="flex flex-col gap-2" aria-live="polite">
                            <p className="m-0 text-sm font-medium">
                                {plural(count, 'person', 'people')} will be enrolled
                            </p>
                            {result.refused.length > 0 && (
                                <>
                                    <p className="m-0 text-sm text-text-muted">
                                        {plural(result.refused.length, 'person cannot be', 'people cannot be')} — each
                                        reason is the server&rsquo;s
                                    </p>
                                    <ul
                                        aria-label="Refused"
                                        className="m-0 list-none divide-y divide-border rounded-md border border-border p-0"
                                    >
                                        {result.refused.map((r) => (
                                            <li
                                                key={r.personId}
                                                className="flex flex-wrap items-baseline gap-x-3 px-3 py-2 text-sm"
                                            >
                                                <span className="font-medium">
                                                    {names.get(r.personId)?.name ?? 'Unknown person'}
                                                </span>
                                                <span className="text-text-muted">
                                                    {names.get(r.personId)?.email ?? ''}
                                                </span>
                                                <span className="ml-auto text-danger">{r.message}</span>
                                            </li>
                                        ))}
                                    </ul>
                                </>
                            )}
                            {warnings.length > 0 && (
                                <ul
                                    aria-label="Check before enrolling"
                                    className="m-0 list-none divide-y divide-border rounded-md border border-border p-0"
                                >
                                    {warnings.map((w) => (
                                        <li
                                            key={`${w.personId}-${w.code}`}
                                            className="flex flex-wrap items-baseline gap-x-3 px-3 py-2 text-sm"
                                        >
                                            <span className="font-medium">
                                                {names.get(w.personId)?.name ?? 'Unknown person'}
                                            </span>
                                            <span className="ml-auto text-warning">{w.message}</span>
                                        </li>
                                    ))}
                                </ul>
                            )}
                            {result.skipped.length > 0 && (
                                <p className="m-0 text-sm text-text-muted">
                                    {result.skipped.length} already in this sequence — skipped, not re-enrolled
                                </p>
                            )}
                        </div>
                    )}
                    {enrol.isError && (
                        <p role="alert" className="m-0 text-sm text-danger">
                            {failureText(enrol.error)}
                        </p>
                    )}
                </DialogBody>
                <DialogFooter>
                    <Button type="button" variant="ghost" shape="square" onClick={() => onOpenChange(false)}>
                        Cancel
                    </Button>
                    <Button
                        type="button"
                        variant="primary"
                        shape="square"
                        loading={enrol.isPending}
                        disabled={!result || count === 0}
                        onClick={confirm}
                    >
                        {`Enrol ${plural(count, 'person', 'people')}`}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

/** The one sentence a finished enrolment toasts. */
export function enrolSummary(result: EnrolmentBatchView): string {
    const parts = [`${plural(result.enrolled.length, 'person', 'people')} enrolled`];
    if (result.skipped.length) parts.push(`${result.skipped.length} already in it`);
    if (result.refused.length) parts.push(`${result.refused.length} refused`);
    return parts.join(' · ');
}

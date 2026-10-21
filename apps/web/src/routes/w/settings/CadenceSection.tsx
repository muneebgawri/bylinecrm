import { Button, Input, toast } from '@bylinecrm/ui';
import { useState } from 'react';
import { useSetCadence } from '../../../api/rotation';
import type { PipelineView } from '../../../api/types';
import { failureText } from '../../../lib/errors';

/**
 * CADENCE-1: how often a deal in each open stage is due a touch — an email, a reply, a call or note, a completed
 * task, a meeting or a stage move by its owner. Closed stages have none. Editable with `pipeline:cadence` (admins and
 * managers); a blank box means no cadence for that stage.
 */
export function CadenceSection({
    workspaceId,
    pipeline,
    canEdit,
}: {
    workspaceId: string;
    pipeline: PipelineView;
    canEdit: boolean;
}) {
    const open = pipeline.stages.filter((s) => s.kind === 'open');
    const initial = () =>
        Object.fromEntries(open.map((s) => [s.id, s.cadenceDays === null ? '' : String(s.cadenceDays)]));
    const [days, setDays] = useState<Record<string, string>>(initial);
    const save = useSetCadence(workspaceId, pipeline.id);
    const changed = open.filter((s) => (days[s.id] ?? '') !== (s.cadenceDays === null ? '' : String(s.cadenceDays)));
    const invalid = open.some((s) => {
        const v = days[s.id] ?? '';
        return v !== '' && !(Number.isInteger(Number(v)) && Number(v) >= 1 && Number(v) <= 365);
    });

    return (
        <section aria-labelledby={`cadence-${pipeline.id}`} className="rounded-lg border border-border bg-surface">
            <header className="grid gap-0.5 border-b border-border px-4 py-3">
                <h3 id={`cadence-${pipeline.id}`} className="m-0 text-sm font-semibold">
                    Follow-up cadence{pipeline.name ? ` · ${pipeline.name}` : ''}
                </h3>
                <p className="m-0 text-xs text-text-muted">
                    Days a deal in each stage may go without a touch before it is overdue and its owner is warned. Leave
                    blank for no cadence.
                </p>
            </header>
            <ul className="m-0 grid list-none gap-2 p-4">
                {open.map((s) => (
                    <li key={s.id} className="flex flex-wrap items-center gap-3">
                        <label htmlFor={`cadence-${s.id}`} className="min-w-40 text-sm">
                            {s.name}
                        </label>
                        <Input
                            id={`cadence-${s.id}`}
                            className="w-24"
                            inputMode="numeric"
                            disabled={!canEdit}
                            value={days[s.id] ?? ''}
                            onChange={(e) => setDays((d) => ({ ...d, [s.id]: e.target.value.trim() }))}
                        />
                        <span className="text-xs text-text-muted">days</span>
                    </li>
                ))}
            </ul>
            {canEdit && (
                <footer className="flex items-center gap-3 border-t border-border px-4 py-3">
                    {invalid && <span className="text-xs text-danger">Use whole days from 1 to 365.</span>}
                    <Button
                        className="ml-auto"
                        size="sm"
                        variant="primary"
                        disabled={changed.length === 0 || invalid || save.isPending}
                        onClick={() =>
                            save.mutate(
                                changed.map((s) => ({
                                    stageId: s.id,
                                    cadenceDays: days[s.id] ? Number(days[s.id]) : null,
                                })),
                                {
                                    onSuccess: () => toast({ title: 'Cadence saved' }),
                                    onError: (e) => toast({ title: failureText(e), tone: 'danger' }),
                                },
                            )
                        }
                    >
                        Save cadence
                    </Button>
                </footer>
            )}
        </section>
    );
}

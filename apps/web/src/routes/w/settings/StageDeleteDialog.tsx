import { toast } from '@bylinecrm/ui';
import { useState } from 'react';
import { useRemoveStage } from '../../../api/settings';
import type { StageView } from '../../../api/types';
import { ConfirmDialog } from '../../../components/ConfirmDialog';
import { detailNumber } from '../../../api/client';
import { failureText } from '../../../lib/errors';
import { SelectField } from './fields';
import { dealCount, movedDealsText } from './settingsText';

/** What the server said is still in the stage (P1-2b's refusal `details`), once it has said it. */
interface DealsInStage {
    live: number;
    trashed: number;
}

/**
 * Deleting a stage (FR-CRMS-9). One dialog, two steps. First the plain "Delete X?". If the server
 * refuses because deals — live or in the trash — are in the stage, the same dialog becomes "Move N
 * deals to…": the counts are the server's (`details.liveDeals` / `details.trashedDeals`), the targets
 * are the pipeline's other OPEN stages (a delete never closes deals; the server refuses a won or lost
 * target anyway), and the move and the delete go in one request (`moveDealsTo`). Any other refusal
 * — a stage rule pointing here, the last stage — is shown in the server's words.
 */
export function StageDeleteDialog({
    workspaceId,
    pipelineId,
    stage,
    stages,
    onClose,
}: {
    workspaceId: string;
    pipelineId: string;
    stage: StageView | null;
    stages: readonly StageView[];
    onClose: () => void;
}) {
    const remove = useRemoveStage(workspaceId, pipelineId);
    const [inStage, setInStage] = useState<DealsInStage | null>(null);
    const [target, setTarget] = useState<string | undefined>(undefined);

    const close = () => {
        setInStage(null);
        setTarget(undefined);
        remove.reset();
        onClose();
    };

    if (stage === null) return null;
    const targets = stages.filter((s) => s.kind === 'open' && s.id !== stage.id);

    const deleteOnly = () =>
        remove.mutate(
            { stageId: stage.id },
            {
                onSuccess: close,
                onError: (error) => {
                    const live = detailNumber(error, 'liveDeals');
                    const trashed = detailNumber(error, 'trashedDeals');
                    if (live !== undefined && trashed !== undefined && live + trashed > 0) {
                        setInStage({ live, trashed });
                        remove.reset();
                    }
                },
            },
        );

    const moveAndDelete = () => {
        const to = targets.find((s) => s.id === target);
        if (!to || !inStage) return;
        remove.mutate(
            { stageId: stage.id, moveDealsTo: to.id },
            {
                onSuccess: () => {
                    toast({ title: movedDealsText(inStage.live + inStage.trashed, to.name, stage.name) });
                    close();
                },
            },
        );
    };

    const error = remove.error ? failureText(remove.error) : undefined;

    if (inStage === null) {
        return (
            <ConfirmDialog
                open
                onOpenChange={(open) => !open && close()}
                title={`Delete ${stage.name}?`}
                body="Deals in it — the trash included — are moved to a stage you choose first. A stage a rule moves deals into can't go."
                confirm="Delete stage"
                pending={remove.isPending}
                error={error}
                onConfirm={deleteOnly}
            />
        );
    }

    const total = inStage.live + inStage.trashed;
    return (
        <ConfirmDialog
            open
            onOpenChange={(open) => !open && close()}
            title={`Delete ${stage.name}?`}
            body={`Move ${dealCount(total)}${inStage.trashed > 0 ? ` (${inStage.trashed.toLocaleString('en-US')} in the trash)` : ''} to another stage first.`}
            confirm="Move deals and delete"
            pending={remove.isPending}
            confirmDisabled={target === undefined}
            error={error}
            onConfirm={moveAndDelete}
        >
            {targets.length > 0 ? (
                <SelectField
                    label="Move deals to"
                    value={target}
                    onValueChange={setTarget}
                    options={targets.map((s) => ({ value: s.id, label: s.name }))}
                    {...(stage.kind !== 'open' && {
                        hint: `These deals were ${stage.kind}; they reopen in the stage you choose.`,
                    })}
                />
            ) : (
                <p className="m-0 text-sm text-text-muted">
                    This pipeline has no other open stage to move them to. Add one first.
                </p>
            )}
        </ConfirmDialog>
    );
}

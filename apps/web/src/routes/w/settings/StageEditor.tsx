import { STAGE_COLOURS, STAGE_KINDS, type StageColour, type StageKind } from '@bylinecrm/shared';
import {
    Button,
    Dialog,
    DialogBody,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogTitle,
    Field,
    Input,
    cn,
    toneSolid,
} from '@bylinecrm/ui';
import { useState, type FormEvent } from 'react';
import { useAddStage, useUpdateStage } from '../../../api/settings';
import type { StageView } from '../../../api/types';
import { failureText } from '../../../lib/errors';
import { STAGE_TONES } from '../deals/dealsView';
import { SelectField } from './fields';
import { STAGE_COLOUR_LABEL, STAGE_KIND_LABEL } from './settingsText';

/** A stage colour's dot, drawn from the board's one colour→tone map. */
export function StageSwatch({ colour, className }: { colour: StageColour; className?: string }) {
    return (
        <span
            aria-hidden
            className={cn('inline-block size-2.5 shrink-0 rounded-full', toneSolid[STAGE_TONES[colour]], className)}
        />
    );
}

const COLOUR_OPTIONS = STAGE_COLOURS.map((colour) => ({
    value: colour,
    label: STAGE_COLOUR_LABEL[colour],
    leading: <StageSwatch colour={colour} />,
}));
const KIND_OPTIONS = STAGE_KINDS.map((kind) => ({ value: kind, label: STAGE_KIND_LABEL[kind] }));

/** Integer text to a number, or `undefined` when it is not one (the field shows the error). */
function wholeNumber(text: string): number | undefined {
    if (!/^\d+$/.test(text.trim())) return undefined;
    return Number(text.trim());
}

/**
 * Add or edit a stage (FR-CRMS-9): its name, colour, win probability, the days after which a deal
 * sitting in it is flagged on the board, and whether it means open, won or lost. One form for
 * both — a new stage is the empty one.
 */
export function StageEditor({
    workspaceId,
    pipelineId,
    stage,
    onClose,
}: {
    workspaceId: string;
    pipelineId: string;
    /** `null` adds a stage at the end. */
    stage: StageView | null;
    onClose: () => void;
}) {
    const add = useAddStage(workspaceId, pipelineId);
    const update = useUpdateStage(workspaceId, pipelineId);
    const [name, setName] = useState(stage?.name ?? '');
    const [colour, setColour] = useState<StageColour>(stage?.colour ?? 'accent');
    const [kind, setKind] = useState<StageKind>(stage?.kind ?? 'open');
    const [probability, setProbability] = useState(String(stage?.probability ?? 10));
    const [threshold, setThreshold] = useState(stage?.daysThreshold == null ? '' : String(stage.daysThreshold));

    const probabilityValue = wholeNumber(probability);
    const probabilityError =
        probabilityValue === undefined || probabilityValue > 100 ? 'A whole number from 0 to 100.' : undefined;
    const thresholdValue = threshold.trim() === '' ? null : wholeNumber(threshold);
    const thresholdError =
        thresholdValue === undefined || thresholdValue === 0 ? 'A whole number of days, or empty for none.' : undefined;
    const valid = name.trim() !== '' && !probabilityError && !thresholdError;
    const mutation = stage ? update : add;

    const submit = (event: FormEvent) => {
        event.preventDefault();
        if (!valid || probabilityValue === undefined || thresholdValue === undefined) return;
        const input = { name: name.trim(), colour, kind, probability: probabilityValue, daysThreshold: thresholdValue };
        if (stage) update.mutate({ stageId: stage.id, ...input }, { onSuccess: onClose });
        else add.mutate(input, { onSuccess: onClose });
    };

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent>
                <DialogTitle>{stage ? `Edit ${stage.name}` : 'Add stage'}</DialogTitle>
                <DialogDescription>
                    {stage
                        ? 'Changes apply to every deal in this stage.'
                        : 'The new stage goes at the end; drag it into place.'}
                </DialogDescription>
                <form onSubmit={submit}>
                    <DialogBody className="grid gap-4">
                        <Field label="Name" required error={mutation.error ? failureText(mutation.error) : undefined}>
                            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoFocus />
                        </Field>
                        <div className="grid gap-4 sm:grid-cols-2">
                            <SelectField
                                label="Colour"
                                value={colour}
                                onValueChange={setColour}
                                options={COLOUR_OPTIONS}
                            />
                            <SelectField
                                label="Means"
                                value={kind}
                                onValueChange={setKind}
                                options={KIND_OPTIONS}
                                hint="Won and lost close the deal when it lands here."
                            />
                            <Field label="Win probability (%)" error={probabilityError}>
                                <Input
                                    inputMode="numeric"
                                    value={probability}
                                    onChange={(e) => setProbability(e.target.value)}
                                />
                            </Field>
                            <Field
                                label="Flag after (days)"
                                hint="A deal in this stage longer than this is marked on the board."
                                error={thresholdError}
                            >
                                <Input
                                    inputMode="numeric"
                                    placeholder="Never"
                                    value={threshold}
                                    onChange={(e) => setThreshold(e.target.value)}
                                />
                            </Field>
                        </div>
                    </DialogBody>
                    <DialogFooter>
                        <Button type="button" shape="square" onClick={onClose}>
                            Cancel
                        </Button>
                        <Button
                            type="submit"
                            shape="square"
                            variant="primary"
                            loading={mutation.isPending}
                            disabled={!valid}
                        >
                            {stage ? 'Save stage' : 'Add stage'}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

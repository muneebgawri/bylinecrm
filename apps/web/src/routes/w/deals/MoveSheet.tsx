import { cn, Dialog, DialogContent, DialogDescription, DialogTitle, toneSolid } from '@bylinecrm/ui';
import { Check } from 'lucide-react';
import type { OpportunityView, StageView } from '../../../api/types';
import { STAGE_TONES } from './dealsView';

export interface MoveSheetProps {
    deal: OpportunityView | null;
    stages: readonly StageView[];
    onClose: () => void;
    /** The one move request (`useDealMove`): it still asks first for a close or a backward move. */
    onPick: (deal: OpportunityView, stageId: string) => void;
}

/**
 * "Move to stage" for touch (FR-CRMS-UI-12): no drag on a finger, a list of stages instead. On a
 * phone the dialog is a bottom sheet (the design system's Dialog below `md`); every row is 44px.
 */
export function MoveSheet({ deal, stages, onClose, onPick }: MoveSheetProps) {
    return (
        <Dialog open={deal !== null} onOpenChange={(open) => !open && onClose()}>
            <DialogContent>
                {deal && (
                    <>
                        <DialogTitle>Move “{deal.name}”</DialogTitle>
                        <DialogDescription>Choose the stage it moves to.</DialogDescription>
                        <ul className="m-0 flex list-none flex-col gap-1 p-0">
                            {stages.map((stage) => {
                                const current = stage.id === deal.stageId;
                                return (
                                    <li key={stage.id}>
                                        <button
                                            type="button"
                                            disabled={current}
                                            aria-current={current ? 'true' : undefined}
                                            onClick={() => {
                                                onClose();
                                                onPick(deal, stage.id);
                                            }}
                                            className={cn(
                                                'flex min-h-11 w-full items-center gap-3 rounded-md px-3 text-left text-base',
                                                'hover:bg-surface disabled:cursor-default disabled:text-text-muted',
                                            )}
                                        >
                                            <span
                                                aria-hidden
                                                className={cn(
                                                    'size-2.5 rounded-full',
                                                    toneSolid[STAGE_TONES[stage.colour]],
                                                )}
                                            />
                                            {stage.name}
                                            {stage.kind !== 'open' && (
                                                <span className="text-sm text-text-muted">closes the deal</span>
                                            )}
                                            {current && <Check aria-hidden className="ml-auto size-4" />}
                                        </button>
                                    </li>
                                );
                            })}
                        </ul>
                    </>
                )}
            </DialogContent>
        </Dialog>
    );
}

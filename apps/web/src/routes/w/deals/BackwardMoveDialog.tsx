import { Button, Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '@bylinecrm/ui';
import type { OpportunityView, RuleView, StageView } from '../../../api/types';

export interface BackwardRequest {
    deal: OpportunityView;
    stage: StageView;
    /** The pipeline's enabled rules whose target is ahead of the new stage: they may move it forward again. */
    rulesAhead: readonly RuleView[];
    stagesById: ReadonlyMap<string, StageView>;
}

export interface BackwardMoveDialogProps {
    request: BackwardRequest | null;
    busy: boolean;
    onCancel: () => void;
    onConfirm: () => void;
}

/** A rule never moves a deal backward; a member may, and is told what may move it forward again (doc 50 §B). */
export function BackwardMoveDialog({ request, busy, onCancel, onConfirm }: BackwardMoveDialogProps) {
    return (
        <Dialog open={request !== null} onOpenChange={(next) => !next && onCancel()}>
            <DialogContent>
                {request && (
                    <>
                        <DialogTitle>
                            Move “{request.deal.name}” back to {request.stage.name}?
                        </DialogTitle>
                        <DialogDescription>
                            {request.rulesAhead.length === 0
                                ? 'No stage rule points past this stage, so it stays until someone moves it.'
                                : 'A stage rule may move it forward again on the next event it matches:'}
                        </DialogDescription>
                        {request.rulesAhead.length > 0 && (
                            <DialogBody>
                                <ul className="m-0 list-disc pl-5 text-sm text-text-muted">
                                    {request.rulesAhead.map((rule) => (
                                        <li key={rule.id}>
                                            {ruleEventLabel(rule.event)} →{' '}
                                            {request.stagesById.get(rule.toStageId)?.name ?? 'a later stage'}
                                        </li>
                                    ))}
                                </ul>
                            </DialogBody>
                        )}
                        <DialogFooter>
                            <Button variant="secondary" shape="square" onClick={onCancel} disabled={busy}>
                                Cancel
                            </Button>
                            <Button variant="primary" shape="square" onClick={onConfirm} loading={busy}>
                                Move back
                            </Button>
                        </DialogFooter>
                    </>
                )}
            </DialogContent>
        </Dialog>
    );
}

/** The rule's trigger in the member's words — one wording for the dialog and the rules line. */
export function ruleEventLabel(event: RuleView['event']): string {
    return event === 'email.replied' ? 'Reply received' : event === 'meeting.booked' ? 'Meeting booked' : event;
}

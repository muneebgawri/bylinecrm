import { toast } from '@bylinecrm/ui';
import { useCallback, useMemo, useState } from 'react';
import { ApiError } from '../../../api/client';
import { useMoveDeal, useRules } from '../../../api/deals';
import type { BoardView, OpportunityView, RuleView, StageView } from '../../../api/types';
import { BackwardMoveDialog, ruleEventLabel, type BackwardRequest } from './BackwardMoveDialog';
import { CloseDealDialog, type ClosePayload, type CloseRequest } from './CloseDealDialog';
import { classifyMove } from './moveGate';

/**
 * The one way the page moves a deal — drag, keyboard, the list's stage select and the bulk bar
 * all call `request`. It classifies the move (`moveGate`), asks first when the move closes the
 * deal or goes backward, sends it optimistically (`useMoveDeal`), and on a refusal shows the
 * server's reason while the cache snaps back. `announce` feeds the board's live region.
 */
export interface DealMoveApi {
    request: (deal: OpportunityView, toStageId: string) => void;
    /** The dialogs this hook may open; render them once on the page. */
    dialogs: React.ReactNode;
    isMoving: boolean;
}

export function useDealMove(
    workspaceId: string,
    board: BoardView | undefined,
    announce?: (text: string) => void,
): DealMoveApi {
    const move = useMoveDeal(workspaceId);
    const rules = useRules(workspaceId, board?.pipeline.id);
    const [closeRequest, setCloseRequest] = useState<CloseRequest | null>(null);
    const [backwardRequest, setBackwardRequest] = useState<BackwardRequest | null>(null);

    const stagesById = useMemo(
        () => new Map((board?.pipeline.stages ?? []).map((stage) => [stage.id, stage])),
        [board?.pipeline.stages],
    );

    const perform = useCallback(
        (deal: OpportunityView, stage: StageView, close?: ClosePayload) => {
            announce?.(`${deal.name}, moving to ${stage.name}`);
            move.mutate(
                { dealId: deal.id, pipelineId: deal.pipelineId, stageId: stage.id, ...(close ? { close } : {}) },
                {
                    onSuccess: (result) => {
                        announce?.(`${deal.name}, moved to ${stage.name}`);
                        if (result.rulesThatMayMoveItForward.length > 0) {
                            toast({
                                title: `${deal.name} is back in ${stage.name}`,
                                description: `A rule may move it forward again: ${describeRules(result.rulesThatMayMoveItForward, stagesById)}.`,
                                tone: 'info',
                            });
                        }
                    },
                    onError: (error) => {
                        announce?.(`${deal.name} stays in its stage`);
                        toast({
                            title: `${deal.name} was not moved`,
                            description: error instanceof ApiError ? error.message : 'The server could not be reached.',
                            tone: 'danger',
                        });
                    },
                },
            );
        },
        [announce, move, stagesById],
    );

    const request = useCallback(
        (deal: OpportunityView, toStageId: string) => {
            const stages = board?.pipeline.stages ?? [];
            const gate = classifyMove(stages, deal.stageId, toStageId);
            const stage = stagesById.get(toStageId);
            if (gate.kind === 'same' || gate.kind === 'unknown' || !stage) return;
            if (gate.closes) {
                setCloseRequest({ deal, stage });
                return;
            }
            if (gate.kind === 'backward') {
                const rulesAhead = (rules.data ?? []).filter(
                    (rule) => rule.enabled && (stagesById.get(rule.toStageId)?.position ?? 0) > stage.position,
                );
                setBackwardRequest({ deal, stage, rulesAhead, stagesById });
                return;
            }
            perform(deal, stage);
        },
        [board?.pipeline.stages, perform, rules.data, stagesById],
    );

    const dialogs = (
        <>
            <CloseDealDialog
                request={closeRequest}
                busy={move.isPending}
                onCancel={() => setCloseRequest(null)}
                onConfirm={(close) => {
                    if (!closeRequest) return;
                    const { deal, stage } = closeRequest;
                    setCloseRequest(null);
                    perform(deal, stage, close);
                }}
            />
            <BackwardMoveDialog
                request={backwardRequest}
                busy={move.isPending}
                onCancel={() => setBackwardRequest(null)}
                onConfirm={() => {
                    if (!backwardRequest) return;
                    const { deal, stage } = backwardRequest;
                    setBackwardRequest(null);
                    perform(deal, stage);
                }}
            />
        </>
    );

    return { request, dialogs, isMoving: move.isPending };
}

function describeRules(rules: readonly RuleView[], stagesById: ReadonlyMap<string, StageView>): string {
    return rules
        .map((r) => `${ruleEventLabel(r.event)} → ${stagesById.get(r.toStageId)?.name ?? 'a later stage'}`)
        .join('; ');
}

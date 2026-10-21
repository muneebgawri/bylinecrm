import type { StageKind } from '@bylinecrm/shared';

/** What is known about a stage someone asked to delete, gathered in the delete's transaction. */
export interface StageDeleteFacts {
    stageId: string;
    pipelineId: string;
    /** The kind of the stage being deleted: a won or lost stage may hand its deals to another of its kind. */
    stageKind: StageKind;
    /** Deals in the stage that are not in the trash. */
    liveDeals: number;
    /** Deals in the stage that are in the trash: they hold the stage as firmly as live ones. */
    trashedDeals: number;
    /** Stage rules that move deals into this stage. */
    rules: number;
    /** Stages in the pipeline, this one included. */
    siblings: number;
    /** The id the caller named as `moveDealsTo`, if any. */
    moveDealsTo: string | undefined;
    /** That stage, if it exists in this stage's pipeline — `undefined` otherwise. */
    target: { id: string; pipelineId: string; kind: StageKind; name: string } | undefined;
    /** The most deals one delete may move. */
    limit: number;
}

export type StageDeletePlan =
    | { kind: 'delete' }
    | {
          kind: 'move_then_delete';
          target: { id: string; pipelineId: string; kind: StageKind; name: string };
          deals: number;
      }
    | { kind: 'refuse'; reason: 'has_rules'; rules: number }
    | { kind: 'refuse'; reason: 'last_stage' }
    | { kind: 'refuse'; reason: 'has_deals'; liveDeals: number; trashedDeals: number }
    | { kind: 'refuse'; reason: 'target_not_found' }
    | { kind: 'refuse'; reason: 'target_is_stage' }
    | { kind: 'refuse'; reason: 'target_not_open' }
    /** A won stage's deals named a lost target, or the reverse: that would flip how they closed. */
    | { kind: 'refuse'; reason: 'target_other_kind' }
    | { kind: 'refuse'; reason: 'too_many'; deals: number; limit: number };

/**
 * Decides what deleting a stage does (P1-2b). Pure, so every rule is unit-tested: rules pointing at
 * the stage and the last-stage rule refuse first; a named target must be another stage of the same
 * pipeline and open — moving deals into won or lost would close them, and closing many deals is never
 * a side effect of a delete — or, when the deleted stage is itself won or lost, another stage of that
 * same kind, so its deals stay closed as they are (won to won, lost to lost, never across); a stage with deals goes only by moving them all, trashed ones included,
 * up to the limit.
 */
export function planStageDelete(facts: StageDeleteFacts): StageDeletePlan {
    if (facts.rules > 0) return { kind: 'refuse', reason: 'has_rules', rules: facts.rules };
    if (facts.siblings <= 1) return { kind: 'refuse', reason: 'last_stage' };

    const deals = facts.liveDeals + facts.trashedDeals;
    if (facts.moveDealsTo === undefined) {
        if (deals > 0) {
            return {
                kind: 'refuse',
                reason: 'has_deals',
                liveDeals: facts.liveDeals,
                trashedDeals: facts.trashedDeals,
            };
        }
        return { kind: 'delete' };
    }

    if (facts.moveDealsTo === facts.stageId) return { kind: 'refuse', reason: 'target_is_stage' };
    const target = facts.target;
    if (!target || target.id !== facts.moveDealsTo || target.pipelineId !== facts.pipelineId) {
        return { kind: 'refuse', reason: 'target_not_found' };
    }
    if (target.kind !== 'open' && target.kind !== facts.stageKind) {
        return facts.stageKind === 'open'
            ? { kind: 'refuse', reason: 'target_not_open' }
            : { kind: 'refuse', reason: 'target_other_kind' };
    }
    if (deals > facts.limit) return { kind: 'refuse', reason: 'too_many', deals, limit: facts.limit };
    return {
        kind: 'move_then_delete',
        target: { id: target.id, pipelineId: target.pipelineId, kind: target.kind, name: target.name },
        deals,
    };
}

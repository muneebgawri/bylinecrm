import { describe, expect, it } from 'vitest';
import { planStageDelete } from './stage-delete';

const open = { id: 'target', pipelineId: 'p1', kind: 'open' as const, name: 'New' };
const base = {
    stageId: 'gone',
    pipelineId: 'p1',
    stageKind: 'open' as const,
    liveDeals: 0,
    trashedDeals: 0,
    rules: 0,
    siblings: 3,
    limit: 10,
};

describe('FR-CRMS-9 deleting a stage: the plan', () => {
    it('deletes an empty stage outright', () => {
        expect(planStageDelete({ ...base, target: undefined, moveDealsTo: undefined })).toEqual({ kind: 'delete' });
    });

    it('refuses a stage with deals and no target, naming live and trashed counts', () => {
        expect(
            planStageDelete({ ...base, liveDeals: 2, trashedDeals: 1, target: undefined, moveDealsTo: undefined }),
        ).toEqual({ kind: 'refuse', reason: 'has_deals', liveDeals: 2, trashedDeals: 1 });
    });

    it('moves every deal, trashed included, into an open stage of the same pipeline', () => {
        expect(
            planStageDelete({ ...base, liveDeals: 2, trashedDeals: 1, target: open, moveDealsTo: 'target' }),
        ).toEqual({
            kind: 'move_then_delete',
            target: { id: 'target', pipelineId: 'p1', kind: 'open', name: 'New' },
            deals: 3,
        });
    });

    it('refuses a won or lost target: closing deals is never a side effect of a delete', () => {
        for (const kind of ['won', 'lost'] as const) {
            expect(
                planStageDelete({ ...base, liveDeals: 1, target: { ...open, kind }, moveDealsTo: 'target' }),
            ).toEqual({ kind: 'refuse', reason: 'target_not_open' });
        }
    });

    it('lets a won or lost stage hand its deals to another stage of its own kind, or to an open one', () => {
        for (const kind of ['won', 'lost'] as const) {
            expect(
                planStageDelete({
                    ...base,
                    stageKind: kind,
                    liveDeals: 2,
                    target: { ...open, kind },
                    moveDealsTo: 'target',
                }),
            ).toEqual({ kind: 'move_then_delete', target: { ...open, kind }, deals: 2 });
            expect(
                planStageDelete({ ...base, stageKind: kind, liveDeals: 2, target: open, moveDealsTo: 'target' }),
            ).toEqual({ kind: 'move_then_delete', target: open, deals: 2 });
        }
    });

    it('refuses a closed target of the other kind: won never becomes lost by a delete', () => {
        expect(
            planStageDelete({
                ...base,
                stageKind: 'won',
                liveDeals: 1,
                target: { ...open, kind: 'lost' },
                moveDealsTo: 'target',
            }),
        ).toEqual({ kind: 'refuse', reason: 'target_other_kind' });
        expect(
            planStageDelete({
                ...base,
                stageKind: 'lost',
                liveDeals: 1,
                target: { ...open, kind: 'won' },
                moveDealsTo: 'target',
            }),
        ).toEqual({ kind: 'refuse', reason: 'target_other_kind' });
    });

    it('refuses the stage itself as its own target, and a target it cannot find', () => {
        expect(
            planStageDelete({ ...base, liveDeals: 1, target: { ...open, id: 'gone' }, moveDealsTo: 'gone' }),
        ).toEqual({ kind: 'refuse', reason: 'target_is_stage' });
        expect(planStageDelete({ ...base, liveDeals: 1, target: undefined, moveDealsTo: 'nowhere' })).toEqual({
            kind: 'refuse',
            reason: 'target_not_found',
        });
    });

    it('refuses more deals than one request may move', () => {
        expect(
            planStageDelete({ ...base, liveDeals: 8, trashedDeals: 3, target: open, moveDealsTo: 'target' }),
        ).toEqual({ kind: 'refuse', reason: 'too_many', deals: 11, limit: 10 });
    });

    it('keeps the rules and the last-stage refusals ahead of any move', () => {
        expect(planStageDelete({ ...base, liveDeals: 1, rules: 1, target: open, moveDealsTo: 'target' })).toEqual({
            kind: 'refuse',
            reason: 'has_rules',
            rules: 1,
        });
        expect(planStageDelete({ ...base, siblings: 1, target: undefined, moveDealsTo: undefined })).toEqual({
            kind: 'refuse',
            reason: 'last_stage',
        });
    });
});

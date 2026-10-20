import { describe, expect, it } from 'vitest';
import { biginStageIndex, chooseStage, snapshotStage, stagePicklist, type PipelineStageRef } from './stage-map';

const stages: PipelineStageRef[] = [
    { id: 'new', name: 'New Opportunity', kind: 'open' },
    { id: 'contacted', name: 'Contacted', kind: 'open' },
    { id: 'qualified', name: 'Qualified', kind: 'open' },
    { id: 'won', name: 'Closed Won', kind: 'won' },
    { id: 'lost', name: 'Closed Lost', kind: 'lost' },
];

describe('FR-CRMS-25 BIGIN-1 Bigin stage mapping', () => {
    const mapping = biginStageIndex([
        { biginStage: 'First Followup Done', stageId: 'contacted' },
        { biginStage: ' Qualification ', stageId: 'qualified' },
        // An explicit mapping wins over the name match and the heuristic.
        { biginStage: 'Contacted', stageId: 'qualified' },
        { biginStage: 'Deal Won Later', stageId: 'contacted' },
    ]);

    it('the explicit mapping first (case and spaces aside), never unknown', () => {
        expect(chooseStage(stages, mapping, 'first followup done')).toEqual({
            id: 'contacted',
            kind: 'open',
            match: 'mapped',
            unknown: false,
        });
        expect(chooseStage(stages, mapping, 'Qualification').id).toBe('qualified');
        expect(chooseStage(stages, mapping, 'Contacted')).toMatchObject({ id: 'qualified', match: 'mapped' });
        expect(chooseStage(stages, mapping, 'Deal Won Later')).toMatchObject({ id: 'contacted', match: 'mapped' });
    });

    it('then the name, then won/lost by wording, then the first open stage as unknown', () => {
        expect(chooseStage(stages, new Map(), 'contacted')).toMatchObject({ id: 'contacted', match: 'name' });
        expect(chooseStage(stages, new Map(), 'Won')).toMatchObject({ id: 'won', kind: 'won', match: 'closed' });
        expect(chooseStage(stages, new Map(), 'Lost to competitor')).toMatchObject({ id: 'lost', match: 'closed' });
        expect(chooseStage(stages, new Map(), '3rd Followup Done')).toEqual({
            id: 'new',
            kind: 'open',
            match: 'fallback',
            unknown: true,
        });
        expect(chooseStage(stages, new Map(), null)).toMatchObject({ id: 'new', unknown: false });
    });

    it('a mapping to a stage no longer in the default pipeline is ignored', () => {
        const stale = biginStageIndex([{ biginStage: 'Second Follow Up Done', stageId: 'gone' }]);
        expect(chooseStage(stages, stale, 'Second Follow Up Done')).toMatchObject({ id: 'new', unknown: true });
    });

    it('a pipeline without an open stage is refused', () => {
        expect(() => chooseStage([stages[3]!], new Map(), 'x')).toThrow(/no open stage/);
    });

    it("a Deals link's snapshot stage: absent, none, or the raw stage", () => {
        expect(snapshotStage(null)).toBeUndefined();
        expect(snapshotStage({ name: 'Dana', email: null })).toBeUndefined();
        expect(snapshotStage({ stage: null })).toBeNull();
        expect(snapshotStage({ stage: 'Qualification' })).toBe('Qualification');
    });

    it("Zoho's fields answer: the Stage picklist's values, in order, each once, without -None-", () => {
        expect(
            stagePicklist({
                fields: [
                    { api_name: 'Deal_Name' },
                    {
                        api_name: 'Stage',
                        pick_list_values: [
                            { display_value: '-None-', actual_value: '-None-' },
                            { display_value: 'Qualification', actual_value: 'Qualification' },
                            { display_value: 'First Followup Done', actual_value: 'First Followup Done' },
                            { display_value: 'qualification', actual_value: 'qualification' },
                            { display_value: 'Shown', actual_value: '' },
                        ],
                    },
                ],
            }),
        ).toEqual(['Qualification', 'First Followup Done', 'Shown']);
        expect(stagePicklist({ fields: [{ api_name: 'Deal_Name' }] })).toBeNull();
        expect(stagePicklist({})).toBeNull();
    });
});

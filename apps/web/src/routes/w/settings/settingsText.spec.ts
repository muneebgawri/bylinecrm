import { CAPABILITIES } from '@bylinecrm/shared';
import { makeDndAnnouncements } from '@bylinecrm/ui';
import { describe, expect, it } from 'vitest';
import {
    CAPABILITY_AREA_LABEL,
    CAPABILITY_LABEL,
    FIELD_KEY_PATTERN,
    fieldKeyFromLabel,
    ruleSummary,
    stageMovedText,
    stageReorderNames,
} from './settingsText';

describe('FR-CRMS-9: a stage rule reads as a sentence', () => {
    it('names the event and the stage the deal moves to', () => {
        expect(ruleSummary('email.replied', 'Replied', false)).toBe('When a reply arrives, move the deal to Replied');
        expect(ruleSummary('meeting.booked', 'Meeting', false)).toBe(
            'When a meeting is booked, move the deal to Meeting',
        );
    });

    it('says when the rule may move a deal backward', () => {
        expect(ruleSummary('email.replied', 'Replied', true)).toBe(
            'When a reply arrives, move the deal to Replied, even if it is further along',
        );
    });
});

describe('FR-CRMS-UI-8: stage reorder announcements name stages and positions, never ids', () => {
    const stages = [
        { id: '0190a1b2-c3d4-7e5f-8a6b-1c2d3e4f5a01', name: 'New' },
        { id: '0190a1b2-c3d4-7e5f-8a6b-1c2d3e4f5a02', name: 'Contacted' },
        { id: '0190a1b2-c3d4-7e5f-8a6b-1c2d3e4f5a03', name: 'Replied' },
    ];
    const heard: string[] = [];
    const say = makeDndAnnouncements(stageReorderNames(stages, (text) => heard.push(text)));
    const active = { id: stages[1]!.id };
    const over = { id: stages[2]!.id };

    it('speaks pick-up, the position it is over, and a put-back, through the polite region only', () => {
        heard.length = 0;
        expect(say.onDragStart({ active })).toBeUndefined();
        say.onDragOver({ active, over });
        say.onDragCancel({ active, over: null });
        expect(heard).toEqual(['Contacted picked up.', 'Contacted over position 3 of 3.', 'Contacted put back.']);
    });

    it('leaves the drop outcome to the reorder, which says where the stage went', () => {
        heard.length = 0;
        say.onDragEnd({ active, over });
        expect(heard).toEqual([]);
        expect(stageMovedText('Contacted', 2, 3)).toBe('Contacted moved to position 3 of 3.');
    });

    it('never reads an id aloud', () => {
        heard.length = 0;
        say.onDragStart({ active });
        say.onDragOver({ active, over });
        say.onDragOver({ active, over: null });
        say.onDragEnd({ active, over: active });
        const all = heard.join(' ');
        for (const stage of stages) expect(all).not.toContain(stage.id);
        expect(all).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
    });
});

describe('Custom fields (doc 48 §5): a key follows the label', () => {
    it.each([
        ['Last outlet', 'last_outlet'],
        ['  Beat / Vertical  ', 'beat_vertical'],
        ['2026 budget', 'f_2026_budget'],
        ['Café owner', 'cafe_owner'],
        ['!!!', ''],
    ])('%j → %j', (label, key) => {
        expect(fieldKeyFromLabel(label)).toBe(key);
    });

    it('always produces a key the API accepts, at most 64 characters', () => {
        const key = fieldKeyFromLabel('a'.repeat(100));
        expect(key).toHaveLength(64);
        expect(key).toMatch(FIELD_KEY_PATTERN);
    });
});

describe('FR-CRMS-UI-6: every capability has a label and an area', () => {
    it('labels the whole catalogue in words', () => {
        for (const capability of CAPABILITIES) {
            expect(CAPABILITY_LABEL[capability]).toMatch(/^[A-Z][a-z]/);
            expect(CAPABILITY_AREA_LABEL[capability.split(':')[0]!]).toBeTruthy();
        }
    });
});

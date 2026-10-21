import { describe, expect, it } from 'vitest';
import { daysInStage, decideMove, moveEventType } from './stage-moves';

describe('decideMove', () => {
    it('moves forward', () => {
        expect(decideMove(1, 3, false)).toEqual({ kind: 'move' });
    });

    it('is a no-op when the deal is already in the target stage, so a repeated event moves nothing', () => {
        expect(decideMove(3, 3, false)).toEqual({ kind: 'already' });
        expect(decideMove(3, 3, true)).toEqual({ kind: 'already' });
    });

    it('refuses a backward move unless allowed', () => {
        expect(decideMove(4, 2, false)).toEqual({ kind: 'backward' });
        expect(decideMove(4, 2, true)).toEqual({ kind: 'move' });
    });
});

describe('moveEventType', () => {
    // One move is one event, named by where the deal lands.
    it('names a move between open stages deal.stage_changed', () => {
        expect(moveEventType('open')).toBe('deal.stage_changed');
    });

    it('names a move into a won stage deal.won, and nothing else', () => {
        expect(moveEventType('won')).toBe('deal.won');
    });

    it('names a move into a lost stage deal.lost, and nothing else', () => {
        expect(moveEventType('lost')).toBe('deal.lost');
    });

    it('names a reopen (out of won or lost, into an open stage) deal.stage_changed', () => {
        // The source stage does not enter into it: a reopen lands in an open stage.
        expect(moveEventType('open')).toBe('deal.stage_changed');
    });

    it('names a closed deal carried to another stage of its own kind deal.stage_changed: no new close', () => {
        expect(moveEventType('won', 'won')).toBe('deal.stage_changed');
        expect(moveEventType('lost', 'lost')).toBe('deal.stage_changed');
        expect(moveEventType('won', 'open')).toBe('deal.won');
    });
});

describe('daysInStage', () => {
    it('counts whole days from when the stage was entered', () => {
        const entered = new Date('2026-10-01T12:00:00Z');
        expect(daysInStage(entered, new Date('2026-10-01T18:00:00Z'))).toBe(0);
        expect(daysInStage(entered, new Date('2026-10-02T11:59:59Z'))).toBe(0);
        expect(daysInStage(entered, new Date('2026-10-02T12:00:00Z'))).toBe(1);
        expect(daysInStage(entered, new Date('2026-10-22T12:00:00Z'))).toBe(21);
    });

    it('never goes negative when a clock is behind', () => {
        expect(daysInStage(new Date('2026-10-02T00:00:00Z'), new Date('2026-10-01T00:00:00Z'))).toBe(0);
    });
});

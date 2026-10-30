import { describe, expect, it } from 'vitest';
import { completedAtFor } from './task-rules';

const now = new Date('2026-10-09T12:00:00.000Z');
const earlier = new Date('2026-10-01T09:30:00.000Z');

describe('completedAtFor', () => {
    it('is the instant a task becomes done', () => {
        expect(completedAtFor('done', undefined, now)).toEqual(now);
        expect(completedAtFor('done', { status: 'todo', completedAt: null }, now)).toEqual(now);
        expect(completedAtFor('done', { status: 'in_progress', completedAt: null }, now)).toEqual(now);
    });

    it('keeps the original instant while the task stays done', () => {
        expect(completedAtFor('done', { status: 'done', completedAt: earlier }, now)).toEqual(earlier);
    });

    it('is cleared the moment the task leaves done, and is never set otherwise', () => {
        expect(completedAtFor('todo', { status: 'done', completedAt: earlier }, now)).toBeNull();
        expect(completedAtFor('in_progress', { status: 'done', completedAt: earlier }, now)).toBeNull();
        expect(completedAtFor('todo', undefined, now)).toBeNull();
        expect(completedAtFor('in_progress', { status: 'todo', completedAt: null }, now)).toBeNull();
    });

    it('BIGIN-1: an imported task done at its source was done then; one already done keeps its instant', () => {
        expect(completedAtFor('done', undefined, now, earlier)).toEqual(earlier);
        expect(completedAtFor('done', { status: 'todo', completedAt: null }, now, earlier)).toEqual(earlier);
        expect(completedAtFor('done', { status: 'done', completedAt: now }, now, earlier)).toEqual(now);
        expect(completedAtFor('todo', undefined, now, earlier)).toBeNull();
    });
});

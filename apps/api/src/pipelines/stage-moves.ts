/**
 * The rules of moving a deal between stages, as pure functions: the service applies them, the
 * rule engine applies them, the tests pin them.
 */
import type { DomainEventType, StageKind } from '@bylinecrm/shared';

export type MoveDecision =
    /** Move. */
    | { kind: 'move' }
    /** Already there: nothing to write (what makes a repeated event a no-op). */
    | { kind: 'already' }
    /** The target is behind the current stage and this caller may not go back. */
    | { kind: 'backward' };

/**
 * Whether a move from `fromPosition` to `toPosition` happens. A rule never moves a deal backward
 * unless it says it may (FR-CRMS-9); a member moving by hand always may, and is told a rule may
 * move it forward again.
 */
export function decideMove(fromPosition: number, toPosition: number, allowBackward: boolean): MoveDecision {
    if (fromPosition === toPosition) return { kind: 'already' };
    if (toPosition < fromPosition && !allowBackward) return { kind: 'backward' };
    return { kind: 'move' };
}

/** The event a committed move is announced as. */
export type MoveEventType = Extract<DomainEventType, 'deal.stage_changed' | 'deal.won' | 'deal.lost'>;

/**
 * One move is one event, named by the kind of stage the deal lands in: a close is `deal.won` or
 * `deal.lost` and nothing else; every other move — between open stages, a reopen out of a won or
 * lost stage, or a closed deal carried to another stage of its own kind (`fromKind` equal to
 * `toKind`, which is no new close) — is `deal.stage_changed`.
 */
export function moveEventType(toKind: StageKind, fromKind?: StageKind): MoveEventType {
    if (fromKind === toKind) return 'deal.stage_changed';
    if (toKind === 'won') return 'deal.won';
    if (toKind === 'lost') return 'deal.lost';
    return 'deal.stage_changed';
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days since the deal entered its stage, from the latest history row's `enteredAt`. */
export function daysInStage(enteredAt: Date, now: Date = new Date()): number {
    return Math.max(0, Math.floor((now.getTime() - enteredAt.getTime()) / DAY_MS));
}

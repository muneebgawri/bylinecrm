import type { StageKind } from '@bylinecrm/shared';
import type { StageView } from '../../../api/types';

/**
 * What a requested move means before it is sent — the one classification the board's drag, its
 * keyboard twin, the list's stage select and the bulk bar all consult (doc 50 §B). The server
 * decides in the end; this only knows which dialog to show first.
 */
export type MoveGate =
    | { kind: 'same' }
    | { kind: 'unknown' }
    | { kind: 'forward'; closes: Exclude<StageKind, 'open'> | null }
    | { kind: 'backward'; closes: Exclude<StageKind, 'open'> | null };

export function classifyMove(stages: readonly StageView[], fromStageId: string, toStageId: string): MoveGate {
    if (fromStageId === toStageId) return { kind: 'same' };
    const from = stages.find((s) => s.id === fromStageId);
    const to = stages.find((s) => s.id === toStageId);
    if (!from || !to) return { kind: 'unknown' };
    const closes = to.kind === 'open' ? null : to.kind;
    return to.position > from.position ? { kind: 'forward', closes } : { kind: 'backward', closes };
}

/** The lane a keyboard move lands in: clamped to the lanes that exist. */
export function laneAfterKey(current: number, key: 'ArrowLeft' | 'ArrowRight', laneCount: number): number {
    const next = key === 'ArrowLeft' ? current - 1 : current + 1;
    return Math.min(Math.max(next, 0), laneCount - 1);
}

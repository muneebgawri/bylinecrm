import type { TaskStatus } from '@bylinecrm/shared';

/**
 * The one rule for `completedAt`: it is the instant the status became `done`, kept while it
 * stays `done`, and cleared the moment it leaves. The database checks the two columns agree;
 * this is the only place that decides the value.
 */
export function completedAtFor(
    next: TaskStatus,
    previous: { status: TaskStatus; completedAt: Date | null } | undefined,
    now: Date,
): Date | null {
    if (next !== 'done') return null;
    return previous?.status === 'done' && previous.completedAt ? previous.completedAt : now;
}

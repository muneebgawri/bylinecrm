import { describe, expect, it } from 'vitest';
import { resumableSweep, type SweepCursorStore, type SweepPosition } from './resumable-sweep';

/** An in-memory cursor store: what Redis holds between passes. */
function memoryCursors(): SweepCursorStore & { held: Map<string, SweepPosition> } {
    const held = new Map<string, SweepPosition>();
    return {
        held,
        get: (name) => Promise.resolve(held.get(name) ?? null),
        set: (name, position) => {
            if (position) held.set(name, position);
            else held.delete(name);
            return Promise.resolve();
        },
    };
}

interface Row {
    id: string;
    at: Date;
}
const rows: Row[] = Array.from({ length: 25 }, (_, i) => ({
    id: `r${String(i).padStart(2, '0')}`,
    at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
}));
const after = (p: SweepPosition | null) => (r: Row) =>
    !p || r.at.getTime() > new Date(p.at).getTime() || (r.at.getTime() === new Date(p.at).getTime() && r.id > p.id);

function pass(cursors: SweepCursorStore, visited: string[], maxRowsPerPass = 10) {
    return resumableSweep<Row>({
        name: 'test',
        cursors,
        pageSize: 4,
        maxRowsPerPass,
        page: (position, take) => Promise.resolve(rows.filter(after(position)).slice(0, take)),
        position: (r) => ({ at: r.at.toISOString(), id: r.id }),
        visit: (r) => {
            visited.push(r.id);
            return Promise.resolve();
        },
    });
}

describe('#97 a capped sweep resumes where the last pass stopped, never restarts', () => {
    it('examines every candidate across passes, then starts over', async () => {
        const cursors = memoryCursors();
        const seen: string[][] = [[], [], [], []];
        expect(await pass(cursors, seen[0]!)).toEqual({ examined: 10, completed: false });
        expect(await pass(cursors, seen[1]!)).toEqual({ examined: 10, completed: false });
        expect(await pass(cursors, seen[2]!)).toEqual({ examined: 5, completed: true });
        expect([...seen[0]!, ...seen[1]!, ...seen[2]!]).toEqual(rows.map((r) => r.id));
        expect(cursors.held.size).toBe(0);
        await pass(cursors, seen[3]!);
        expect(seen[3]![0]).toBe('r00');
    });

    it('a pass that reaches the end within its cap examines everything once and clears the cursor', async () => {
        const cursors = memoryCursors();
        const seen: string[] = [];
        expect(await pass(cursors, seen, 100)).toEqual({ examined: 25, completed: true });
        expect(seen).toEqual(rows.map((r) => r.id));
        expect(cursors.held.size).toBe(0);
    });

    it('rows with the same time are ordered by id, so none is skipped at a page boundary', async () => {
        const cursors = memoryCursors();
        const same = new Date(Date.UTC(2026, 0, 2));
        const tied: Row[] = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({ id, at: same }));
        const seen: string[] = [];
        for (let i = 0; i < 4; i += 1) {
            await resumableSweep<Row>({
                name: 'tied',
                cursors,
                pageSize: 2,
                maxRowsPerPass: 2,
                page: (position, take) => Promise.resolve(tied.filter(after(position)).slice(0, take)),
                position: (r) => ({ at: r.at.toISOString(), id: r.id }),
                visit: (r) => {
                    seen.push(r.id);
                    return Promise.resolve();
                },
            });
        }
        expect(seen.slice(0, 6)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    });
});

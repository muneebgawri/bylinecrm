import { describe, expect, it } from 'vitest';
import { inBatches } from './reuse-reconciler';

describe('FR-CRMS-26 BIGIN-1 the reconcile reads a whole workspace’s Contacts', () => {
    it('asks in runs under the Postgres bind limit and keeps every row in order', async () => {
        const ids = Array.from({ length: 40_000 }, (_, i) => String(i));
        const runs: number[] = [];
        const rows = await inBatches(ids, async (run) => {
            runs.push(run.length);
            return run;
        });
        expect(runs.every((n) => n < 32_767)).toBe(true);
        expect(rows).toEqual(ids);
    });
});

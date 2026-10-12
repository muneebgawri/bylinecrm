import { describe, expect, it } from 'vitest';
import { mapPool } from './map-pool';

describe('mapPool', () => {
    it('keeps at most `concurrency` calls in flight and returns results in input order', async () => {
        let inFlight = 0;
        let peak = 0;
        const out = await mapPool([30, 10, 20, 5], 2, async (ms) => {
            inFlight += 1;
            peak = Math.max(peak, inFlight);
            await new Promise((r) => setTimeout(r, ms));
            inFlight -= 1;
            return ms * 2;
        });
        expect(out).toEqual([60, 20, 40, 10]);
        expect(peak).toBe(2);
    });

    it('rejects with the first failure', async () => {
        await expect(
            mapPool([1, 2], 2, (n) => (n === 2 ? Promise.reject(new Error('two')) : Promise.resolve(n))),
        ).rejects.toThrow('two');
    });
});

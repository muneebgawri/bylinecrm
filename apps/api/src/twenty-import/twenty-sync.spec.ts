import { TWENTY_SYNC_INTERVAL_MS } from '@bylinecrm/shared';
import { describe, expect, it } from 'vitest';
import { syncWaitMs, withoutLocalEdits } from './twenty-sync';

/**
 * Scheduled Twenty sync (#185, P4-4f): how long a schedule waits after failures in a row, and the
 * precedence rule — Twenty is the source for the fields it maps, except a field edited here after
 * Twenty last touched the record, which keeps BylineCRM's value.
 */
describe('#185 P4-4f scheduled Twenty sync', () => {
    const DAY = 24 * 60 * 60 * 1000;

    it('waits the interval, doubled per failure in a row, at most a day — and never stacks', () => {
        expect(syncWaitMs('15m', 0)).toBe(TWENTY_SYNC_INTERVAL_MS['15m']);
        expect(syncWaitMs('15m', 1)).toBe(2 * TWENTY_SYNC_INTERVAL_MS['15m']);
        expect(syncWaitMs('hourly', 3)).toBe(8 * TWENTY_SYNC_INTERVAL_MS.hourly);
        expect(syncWaitMs('hourly', 6)).toBe(DAY);
        expect(syncWaitMs('daily', 9)).toBe(DAY);
    });

    it('keeps BylineCRM’s value for a field edited here, applies Twenty’s for the rest, and names what it kept', () => {
        const input = { jobTitle: 'CMO', city: 'Lyon', custom: { lists: ['A'] } };
        expect(withoutLocalEdits(input, new Set())).toEqual({ input, kept: [] });
        expect(withoutLocalEdits(input, new Set(['jobTitle']))).toEqual({
            input: { city: 'Lyon', custom: { lists: ['A'] } },
            kept: ['jobTitle'],
        });
        // A local edit of a field Twenty's record does not carry keeps nothing from Twenty.
        expect(withoutLocalEdits(input, new Set(['avatarUrl']))).toEqual({ input, kept: [] });
        // Custom values are one field on the timeline (`custom`): edited here, Twenty's are all kept out.
        expect(withoutLocalEdits(input, new Set(['custom', 'city']))).toEqual({
            input: { jobTitle: 'CMO' },
            kept: ['city', 'custom'],
        });
    });
});

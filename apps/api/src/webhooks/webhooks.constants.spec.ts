import { describe, expect, it } from 'vitest';
import {
    WEBHOOK_MAX_ATTEMPTS,
    WEBHOOK_RETRY_BASE_MS,
    WEBHOOK_RETRY_FACTOR,
    WEBHOOK_RETRY_JITTER,
    WEBHOOK_RETRY_MAX_MS,
    backoffDelayMs,
} from './webhooks.constants';

describe('the retry schedule', () => {
    const noJitter = () => 0.5;

    it('doubles from the base, capped, with the jitter removed', () => {
        const waits = Array.from({ length: WEBHOOK_MAX_ATTEMPTS - 1 }, (_, i) => backoffDelayMs(i + 1, noJitter));
        expect(waits).toEqual([1_000, 2_000, 4_000, 8_000]);
        expect(backoffDelayMs(20, noJitter)).toBe(WEBHOOK_RETRY_MAX_MS);
        expect(WEBHOOK_RETRY_BASE_MS * WEBHOOK_RETRY_FACTOR ** 3).toBe(8_000);
    });

    it('jitter stays within ± the constant', () => {
        expect(backoffDelayMs(2, () => 0)).toBe(Math.round(2_000 * (1 - WEBHOOK_RETRY_JITTER)));
        expect(backoffDelayMs(2, () => 1)).toBe(Math.round(2_000 * (1 + WEBHOOK_RETRY_JITTER)));
    });
});

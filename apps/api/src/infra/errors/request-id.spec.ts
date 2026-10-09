import { describe, expect, it } from 'vitest';
import { chooseRequestId } from './request-id';

describe('chooseRequestId', () => {
    it('keeps a well-formed inbound id', () => {
        expect(chooseRequestId('edge-7f3a9c1e')).toBe('edge-7f3a9c1e');
        expect(chooseRequestId('0190a1b2-c3d4-7e5f-8a6b-1c2d3e4f5a6b')).toBe('0190a1b2-c3d4-7e5f-8a6b-1c2d3e4f5a6b');
    });

    it.each([
        ['missing', undefined],
        ['too short', 'abc'],
        ['spaces', 'not an id at all'],
        ['a log-injection attempt', 'ok\nFAKE LOG LINE'],
        ['too long', 'a'.repeat(129)],
        ['a repeated header', ['a1b2c3d4e5', 'f6g7h8i9j0']],
    ])('replaces an id that is %s', (_label, inbound) => {
        const chosen = chooseRequestId(inbound);
        expect(chosen).not.toBe(inbound);
        expect(chosen).toMatch(/^[0-9a-f-]{36}$/);
    });
});

import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { dedupeTargets, parseTarget, targetKey } from './targets';

const id = '0192f7a0-5a7e-7c2a-9f4e-3f1c2b8d6e01';

describe('parseTarget', () => {
    it('reads <object>:<uuid>', () => {
        expect(parseTarget(`person:${id}`)).toEqual({ type: 'person', id });
        expect(parseTarget(`opportunity:${id.toUpperCase()}`)).toEqual({ type: 'opportunity', id: id.toUpperCase() });
    });

    it('refuses an unknown object, a bad id, or no colon', () => {
        for (const raw of [`deal:${id}`, 'person:nope', 'person', `:${id}`, '']) {
            expect(() => parseTarget(raw), raw).toThrow(BadRequestException);
        }
    });
});

describe('dedupeTargets', () => {
    it('keeps the first of equal targets and the order of the rest', () => {
        const a = { type: 'person' as const, id };
        const b = { type: 'company' as const, id };
        expect(dedupeTargets([a, b, { ...a }, b])).toEqual([a, b]);
        expect(targetKey(a)).toBe(`person:${id}`);
    });
});

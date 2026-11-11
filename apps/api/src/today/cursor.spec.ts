import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { decodeSectionCursor, encodeSectionCursor } from './cursor';

describe('Today section cursor (#360)', () => {
    const cursor = { key: new Date('2026-11-01T09:30:00.000Z'), id: '0190a1b2-c3d4-7e5f-8a6b-1c2d3e4f5a6b' };

    it('round-trips the sort key and the id, opaque to the client', () => {
        const raw = encodeSectionCursor(cursor);
        expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
        expect(decodeSectionCursor(raw)).toEqual(cursor);
    });

    it.each([
        ['not base64 JSON', 'not-a-cursor'],
        ['a bare id', Buffer.from(cursor.id).toString('base64url')],
        ['a bad date', Buffer.from(JSON.stringify(['yesterday', cursor.id])).toString('base64url')],
        ['a bad id', Buffer.from(JSON.stringify([cursor.key.toISOString(), 'x'])).toString('base64url')],
    ])('refuses %s with a 400', (_what, raw) => {
        expect(() => decodeSectionCursor(raw)).toThrow(BadRequestException);
    });
});

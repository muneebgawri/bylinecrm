import { describe, expect, it } from 'vitest';
import { ValidationFailed } from '../infra/errors/api-errors';
import { editedVersion } from './edited-version';

describe('editedVersion', () => {
    it('reads the body or the header, in any of If-Match’s spellings', () => {
        expect(editedVersion(4, undefined)).toBe(4);
        expect(editedVersion(undefined, '4')).toBe(4);
        expect(editedVersion(undefined, '"4"')).toBe(4);
        expect(editedVersion(undefined, 'W/"4"')).toBe(4);
        expect(editedVersion(4, '"4"')).toBe(4);
    });

    it.each([
        [undefined, undefined],
        [undefined, ''],
        [undefined, '*'],
        [undefined, '"0"'],
        [undefined, 'abc'],
        [3, '"4"'],
    ])('refuses body %j with If-Match %j', (body, header) => {
        expect(() => editedVersion(body, header)).toThrow(ValidationFailed);
    });
});

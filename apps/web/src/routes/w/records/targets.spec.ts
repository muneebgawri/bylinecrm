import { describe, expect, it } from 'vitest';
import { formatTarget, parseTarget, withOpen } from './targets';

const ID = '0f1c7b1e-2a2b-4c3d-8e4f-5a6b7c8d9e0f';

describe('targets', () => {
    it('parses the API spelling and nothing else', () => {
        expect(parseTarget(`person:${ID}`)).toEqual({ type: 'person', id: ID });
        expect(parseTarget(`deal:${ID}`)).toBeNull();
        expect(parseTarget('person:not-a-uuid')).toBeNull();
        expect(parseTarget(null)).toBeNull();
    });

    it('round-trips', () => {
        expect(parseTarget(formatTarget({ type: 'company', id: ID }))).toEqual({ type: 'company', id: ID });
    });

    it('sets and clears `open` without touching other params', () => {
        expect(withOpen('?create=1', { type: 'person', id: ID })).toBe(`?create=1&open=person%3A${ID}`);
        expect(withOpen(`?open=person%3A${ID}&q=dana`, null)).toBe('?q=dana');
        expect(withOpen('', null)).toBe('');
    });
});

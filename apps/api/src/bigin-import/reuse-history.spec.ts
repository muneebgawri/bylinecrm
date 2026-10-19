import { describe, expect, it } from 'vitest';
import { identityHistory } from './reuse-history';

const at = (iso: string) => new Date(iso);

describe('FR-CRMS-26 Bigin contact reuse history', () => {
    it('a mixed row (new name, old address): the name change and the address the logs show later are one reuse', () => {
        const history = identityHistory({
            holder: { first: 'Kim', last: 'Gifford', email: 'support@pressreleasesubmit.com' },
            changes: [
                {
                    at: at('2026-03-01T00:00:00Z'),
                    name: {
                        before: { first: 'Press release', last: 'Submit' },
                        after: { first: 'Kim', last: 'Gifford' },
                    },
                },
            ],
            observations: [
                {
                    at: at('2026-03-02T00:00:00Z'),
                    identity: { first: 'Kim', last: 'Gifford', email: 'kim@gifford.example' },
                },
            ],
        });
        expect(history.review).toEqual([]);
        expect(history.segments).toEqual([
            {
                identity: { first: 'Press release', last: 'Submit', email: 'support@pressreleasesubmit.com' },
                from: null,
            },
            {
                identity: { first: 'Kim', last: 'Gifford', email: 'kim@gifford.example' },
                from: at('2026-03-01T00:00:00Z'),
            },
        ]);
    });

    it('a name change with the same address is not split: it is for review', () => {
        const history = identityHistory({
            holder: { first: 'Chris', last: 'Newname', email: 'chris@acme.example' },
            changes: [
                {
                    at: at('2026-02-01T00:00:00Z'),
                    name: { before: { first: 'Chris', last: 'Oldname' }, after: { first: 'Chris', last: 'Newname' } },
                },
            ],
            observations: [],
        });
        expect(history.segments).toHaveLength(1);
        expect(history.segments[0]!.identity).toEqual({ first: 'Chris', last: 'Newname', email: 'chris@acme.example' });
        expect(history.review).toHaveLength(1);
        expect(history.review[0]).toContain('same address');
    });

    it('an address and name change recorded by Twenty itself splits; a later case-only change does not', () => {
        const history = identityHistory({
            holder: { first: 'B', last: 'Two', email: 'b@two.example' },
            changes: [
                {
                    at: at('2026-01-10T00:00:00Z'),
                    name: { before: { first: 'A', last: 'One' }, after: { first: 'B', last: 'Two' } },
                    email: { before: 'a@one.example', after: 'b@two.example' },
                },
                { at: at('2026-01-20T00:00:00Z'), email: { before: 'b@two.example', after: 'B@Two.example' } },
            ],
            observations: [],
        });
        expect(history.segments.map((s) => s.identity.email)).toEqual(['a@one.example', 'B@Two.example']);
        expect(history.review).toEqual([]);
    });

    it('no history: one person, nothing to review', () => {
        expect(
            identityHistory({
                holder: { first: 'A', last: 'One', email: 'a@one.example' },
                changes: [],
                observations: [],
            }),
        ).toEqual({
            segments: [{ identity: { first: 'A', last: 'One', email: 'a@one.example' }, from: null }],
            review: [],
        });
    });
});

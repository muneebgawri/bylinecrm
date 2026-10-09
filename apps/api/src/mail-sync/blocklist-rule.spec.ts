import { describe, expect, it } from 'vitest';
import { entriesFor, everyOutsideBlocked } from './blocklist-rule';

const personal = { email: 'me@pinion.example', ownerMemberId: 'm1', purpose: 'personal' as const };
const pool = { email: 'pool@pinion.example', ownerMemberId: 'm1', purpose: 'pool' as const };
const entries = [
    { value: '@spam.example', memberId: null },
    { value: 'noisy@vendor.example', memberId: 'm1' },
    { value: 'other@vendor.example', memberId: 'm2' },
];

describe('entriesFor', () => {
    it("applies the workspace's entries everywhere and a member's own only to their personal mailboxes", () => {
        expect(entriesFor(personal, entries)).toEqual(['@spam.example', 'noisy@vendor.example']);
        expect(entriesFor(pool, entries)).toEqual(['@spam.example']);
    });
});

describe('everyOutsideBlocked', () => {
    const values = ['@spam.example', 'noisy@vendor.example'];
    it('is true only when every address other than the mailbox is covered', () => {
        expect(everyOutsideBlocked('me@pinion.example', ['me@pinion.example', 'a@spam.example'], values)).toBe(true);
        expect(everyOutsideBlocked('me@pinion.example', ['a@spam.example', 'dana@acme.example'], values)).toBe(false);
        expect(everyOutsideBlocked('me@pinion.example', ['noisy@vendor.example', 'b@spam.example'], values)).toBe(true);
    });
    it('never blocks mail with no outside participant', () => {
        expect(everyOutsideBlocked('me@pinion.example', ['me@pinion.example'], values)).toBe(false);
    });
});

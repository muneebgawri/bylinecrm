import { describe, expect, it } from 'vitest';
import { accountOwnedMessage } from './recipient-guard';

describe('accountOwnedMessage (GUARD-1)', () => {
    const base = { companyName: 'Acme Fund', ownerName: 'Kate', domain: null, sendersLead: false };

    it('names the domain when that is what tied the recipient to the company', () => {
        expect(accountOwnedMessage({ ...base, domain: 'parent.example' })).toBe(
            'Everyone at parent.example belongs to Acme Fund, which is Kate’s account — only the account’s owner can email people there. Ask Kate to introduce you',
        );
    });

    it('tells a sender who owns the lead that the account’s owner still comes first', () => {
        expect(accountOwnedMessage({ ...base, domain: 'parent.example', sendersLead: true })).toBe(
            'This is your lead, but everyone at parent.example belongs to Acme Fund, which is Kate’s account — only the account’s owner can email people there. Ask Kate to introduce you',
        );
        expect(accountOwnedMessage({ ...base, sendersLead: true })).toMatch(
            /^This is your lead, but they are at Acme Fund,/,
        );
    });

    it('says the person is at the company when their record is linked to it, and copes with an unnamed owner', () => {
        expect(accountOwnedMessage({ ...base, ownerName: null })).toBe(
            'This person is at Acme Fund, which is another member’s account — only the account’s owner can email people there. Ask them to introduce you',
        );
    });
});

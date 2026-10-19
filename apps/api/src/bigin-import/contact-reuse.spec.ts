import { describe, expect, it } from 'vitest';
import { isContactReused, reuseNoteText } from './contact-reuse';

const who = (name: string, email: string | null) => ({ name, email });

describe('FR-CRMS-25 BIGIN-1 contact reuse detection', () => {
    it('the same person: an unchanged address, one changed only in case or whitespace, or none before', () => {
        expect(isContactReused(who('Dana Lee', 'dana@acme.com'), who('Dana Lee', 'dana@acme.com'))).toBe(false);
        expect(isContactReused(who('Dana Lee', 'dana@acme.com'), who('Dana Leigh', ' Dana@ACME.com '))).toBe(false);
        expect(isContactReused(who('Dana Lee', null), who('Sam Roe', 'sam@other.com'))).toBe(false);
        expect(isContactReused(who('Dana Lee', ''), who('Sam Roe', 'sam@other.com'))).toBe(false);
    });

    it('the same person: an address removed, or changed within the same registrable domain under the same name', () => {
        expect(isContactReused(who('Dana Lee', 'dana@acme.com'), who('Dana Lee', null))).toBe(false);
        expect(isContactReused(who('Dana Lee', 'dana@acme.com'), who('Dana  lee', 'd.lee@mail.acme.com'))).toBe(false);
    });

    it('reused: another address and another name', () => {
        expect(isContactReused(who('Dana Lee', 'dana@acme.com'), who('Sam Roe', 'sam@acme.com'))).toBe(true);
    });

    it('the same person: a new address at another domain under the same name is a move, not someone else', () => {
        expect(isContactReused(who('Dana Lee', 'dana@acme.com'), who('Dana Lee', 'dana@globex.com'))).toBe(false);
        expect(isContactReused(who('Jane Doe', 'jane@gmail.com'), who('Jane Doe', 'jane@acme.com'))).toBe(false);
    });

    it('reused: a new address and a new name', () => {
        expect(isContactReused(who('Dana Lee', 'dana@acme.com'), who('Kim Ito', 'kim@globex.com'))).toBe(true);
    });

    it('the note names the day it was detected', () => {
        expect(reuseNoteText(new Date('2026-10-19T15:00:00Z'))).toBe(
            'This Bigin contact was reused for another person on 2026-10-19',
        );
    });
});

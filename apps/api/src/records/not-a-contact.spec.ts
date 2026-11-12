import { describe, expect, it } from 'vitest';
import { isSystemSender } from '@bylinecrm/shared';
import { notAContactReason } from './not-a-contact';

describe('not a contact (#383)', () => {
    const staff = new Set(['kate@pinion.test', 'media@pinion.test']);

    it('names automated senders by their local part, with or without a suffix, whatever the case or domain', () => {
        for (const address of [
            'mailer-daemon@googlemail.com',
            'MAILER-DAEMON@mx1.example.net',
            'postmaster@contoso.onmicrosoft.com',
            'noreply@discord.com',
            'no-reply@accounts.google.com',
            'notifications@bigin.com',
            'notifications-noreply@linkedin.com',
            'notification@github.com',
            'donotreply@bank.test',
            'do-not-reply@bank.test',
            'bounces+abc@mail.example.com',
            'bounce@em.example.com',
        ]) {
            expect(isSystemSender(address), address).toBe(true);
        }
    });

    it('lets a person whose name merely contains such a word through', () => {
        for (const address of [
            'dana@example.test',
            'postmaster.jones@example.test',
            'noreplyman@example.test',
            'notifications.lead@example.test',
            'bouncer@example.test',
            'ann.postmaster@example.test',
            'not-an-address',
        ]) {
            expect(isSystemSender(address), address).toBe(false);
        }
    });

    it("refuses a member's or mailbox's address and an automated sender's, and allows a contact's", () => {
        expect(notAContactReason('Kate@Pinion.test', staff)).toMatch(/member/);
        expect(notAContactReason(' media@pinion.test ', staff)).toMatch(/mailbox/);
        expect(notAContactReason('Postmaster@Somewhere.test', staff)).toMatch(/automated sender/);
        expect(notAContactReason('dana@example.test', staff)).toBeNull();
    });
});

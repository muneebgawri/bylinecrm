import { MAIL_SEND_HORIZON_DAYS } from '@bylinecrm/shared';
import { describe, expect, it } from 'vitest';
import { outboundPollMs } from '../../../api/mail';
import { RECIPIENT_ZONE_UNKNOWN, fromLocalInput, scheduleProblem, toLocalInput } from './schedule';

const NOW = Date.parse('2026-10-09T09:00:00.000Z');

describe('FR-CRMS-UI-2 / P2-5: when a send may be scheduled', () => {
    it('refuses a time under the minimum lead and beyond the horizon, from the shared numbers', () => {
        expect(scheduleProblem(new Date(NOW + 30_000), NOW)).toBe('Pick a time at least 1 minute from now.');
        expect(scheduleProblem(new Date(NOW + 61_000), NOW)).toBeNull();
        expect(scheduleProblem(new Date(NOW + (MAIL_SEND_HORIZON_DAYS + 1) * 86_400_000), NOW)).toBe(
            `Pick a time within ${MAIL_SEND_HORIZON_DAYS} days.`,
        );
        expect(scheduleProblem(null, NOW)).toBe('Pick a date and time.');
    });

    it('says the recipient’s zone is unknown rather than guessing it', () => {
        expect(RECIPIENT_ZONE_UNKNOWN).toBe('Recipient’s zone unknown');
    });

    it('round-trips a picker value in the browser’s zone', () => {
        const at = fromLocalInput('2026-10-12T09:30');
        expect(at && toLocalInput(at)).toBe('2026-10-12T09:30');
        expect(fromLocalInput('tomorrow')).toBeNull();
    });
});

describe('FR-CRMS-UI-2: a send’s status is read back with backoff until final', () => {
    it('backs off 1s, 2s, 4s … to 15s while going, and stops once final and stored', () => {
        const going = { status: 'sending' as const, sendAt: null, mailMessageId: null };
        expect([1, 2, 3, 4, 5, 6].map((n) => outboundPollMs(going, n, NOW))).toEqual([
            1_000, 2_000, 4_000, 8_000, 15_000, 15_000,
        ]);
        expect(outboundPollMs({ status: 'failed', sendAt: null, mailMessageId: null }, 3, NOW)).toBe(false);
        expect(outboundPollMs({ status: 'cancelled', sendAt: null, mailMessageId: null }, 3, NOW)).toBe(false);
        expect(outboundPollMs({ status: 'sent', sendAt: null, mailMessageId: 'mm-1' }, 3, NOW)).toBe(false);
        // Sent, but its stored copy is not there yet: keep reading, so the timeline entry can replace it.
        expect(outboundPollMs({ status: 'sent', sendAt: null, mailMessageId: null }, 3, NOW)).toBe(4_000);
    });

    it('reads a scheduled send again shortly after its time, at most every five minutes', () => {
        const soon = new Date(NOW + 20_000).toISOString();
        const later = new Date(NOW + 3_600_000).toISOString();
        expect(outboundPollMs({ status: 'scheduled', sendAt: soon, mailMessageId: null }, 1, NOW)).toBe(20_000);
        expect(outboundPollMs({ status: 'scheduled', sendAt: later, mailMessageId: null }, 1, NOW)).toBe(300_000);
    });
});

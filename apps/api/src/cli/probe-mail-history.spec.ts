import { describe, expect, it } from 'vitest';
import { GMAIL_EPOCH, oldestMonth } from './probe-mail-history';

describe('probe-mail-history: the first month a mailbox holds mail', () => {
    const floor = new Date('2023-04-01T00:00:00Z');
    /** A mailbox whose oldest message was sent at `oldest`, answering "anything before this date?". */
    const mailboxFrom = (oldest: Date) => {
        let asked = 0;
        const has = (before: Date) => {
            asked += 1;
            return Promise.resolve(oldest.getTime() < before.getTime());
        };
        return { has, asked: () => asked };
    };

    it('finds the month, whatever day of it the oldest message was sent on, in about eight questions', async () => {
        for (const sent of [
            '2019-11-01T00:00:00Z',
            '2019-11-30T23:59:59Z',
            '2004-04-15T12:00:00Z',
            '2023-03-31T23:00:00Z',
        ]) {
            const box = mailboxFrom(new Date(sent));
            const found = await oldestMonth(box.has, floor);
            expect(found?.toISOString().slice(0, 7)).toBe(sent.slice(0, 7));
            expect(box.asked()).toBeLessThanOrEqual(10);
        }
    });

    it('answers null for a mailbox with nothing older than the floor, after one question', async () => {
        const box = mailboxFrom(new Date('2023-04-01T00:00:00Z'));
        expect(await oldestMonth(box.has, floor)).toBeNull();
        expect(box.asked()).toBe(1);
    });

    it('never asks about anything before Gmail existed', async () => {
        const asked: Date[] = [];
        const box = mailboxFrom(new Date('2004-04-01T00:00:00Z'));
        await oldestMonth((d) => (asked.push(d), box.has(d)), floor);
        expect(asked.every((d) => d.getTime() >= GMAIL_EPOCH.getTime())).toBe(true);
    });
});

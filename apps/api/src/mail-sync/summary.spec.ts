import type { DomainEvent } from '@bylinecrm/shared';
import { describe, expect, it } from 'vitest';
import { isHistoricalMail } from './summary';

const DAY = 24 * 60 * 60 * 1000;
const now = Date.parse('2026-11-11T12:00:00Z');
const mail = (type: string, sentAt: Date, historical?: boolean): DomainEvent =>
    ({
        type,
        object: 'email',
        workspaceId: 'w',
        actor: { kind: 'sync', id: 'm' },
        occurredAt: sentAt.toISOString(),
        recordId: 'r',
        email: {
            messageId: 'r',
            threadId: 't',
            mailboxId: 'm',
            direction: type === 'email.sent' ? 'outbound' : 'inbound',
            subject: '',
            snippet: '',
            from: 'a@b.test',
            sentAt: sentAt.toISOString(),
            rfc822MessageId: null,
            inReplyTo: null,
            references: [],
            ...(historical ? { historical } : {}),
        },
    }) as DomainEvent;

describe('isHistoricalMail: old mail the history backfill stored, not news', () => {
    it('is what the backfill flagged, whatever its date', () => {
        expect(isHistoricalMail(mail('email.received', new Date(now - DAY), true), now)).toBe(true);
    });

    it('is mail older than the first import reaches (an event queued before the flag existed)', () => {
        expect(isHistoricalMail(mail('email.sent', new Date(now - 40 * DAY)), now)).toBe(true);
        expect(isHistoricalMail(mail('email.sent', new Date(now - 20 * DAY)), now)).toBe(false);
        expect(isHistoricalMail(mail('email.received', new Date(now - 60_000)), now)).toBe(false);
    });

    it('is only ever stored mail: a reply, a click or a link is always news', () => {
        expect(isHistoricalMail(mail('email.replied', new Date(now - 90 * DAY)), now)).toBe(false);
        expect(isHistoricalMail(mail('email.linked', new Date(now - 90 * DAY)), now)).toBe(false);
    });
});

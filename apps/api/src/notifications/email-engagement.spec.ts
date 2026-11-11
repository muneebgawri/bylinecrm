import type { DomainEvent } from '@bylinecrm/shared';
import { describe, expect, it } from 'vitest';
import { engagementOf, engagementRecipient } from './email-engagement';

const member = (id: string, over: Partial<Parameters<typeof engagementRecipient>[1]> = {}) => ({
    id,
    leftAt: null,
    notifyEmailReplies: true,
    notifyEmailClicks: true,
    notifyEmailOpens: true,
    ...over,
});

const base = {
    object: 'email',
    workspaceId: 'ws',
    actor: { kind: 'system', id: null },
    occurredAt: '2026-11-06T10:00:00Z',
    recordId: 'r',
} as const;

describe('email engagement notifications: what tells whom', () => {
    it('a reply is about the inbound message; a click or an open about the send', () => {
        const reply = {
            ...base,
            type: 'email.replied',
            reply: {
                messageId: 'in-1',
                inReplyToOutboundId: 'out-1',
                inReplyToMessageId: null,
                threadId: 't',
                personIds: ['p-1'],
                dealIds: [],
            },
        } as DomainEvent;
        expect(engagementOf(reply)).toEqual({
            kind: 'email_replied',
            outboundId: 'out-1',
            personIds: ['p-1'],
            target: { type: 'reply', id: 'in-1' },
        });
        const tracking = {
            outboundId: 'out-2',
            personId: null,
            url: null,
            sequenceStepId: null,
            enrolmentId: null,
            indicative: true,
        };
        expect(engagementOf({ ...base, type: 'email.opened', tracking } as DomainEvent)).toEqual({
            kind: 'email_opened',
            outboundId: 'out-2',
            personIds: [],
            target: { type: 'email', id: 'out-2' },
        });
        expect(engagementOf({ ...base, type: 'email.clicked', tracking } as DomainEvent)?.kind).toBe('email_clicked');
        // No payload, or another event: nobody.
        expect(engagementOf({ ...base, type: 'email.replied' } as DomainEvent)).toBeNull();
        expect(engagementOf({ ...base, type: 'email.sent' } as DomainEvent)).toBeNull();
    });

    it('tells the sender; once they left, the person’s owner; nobody who turned the kind off', () => {
        expect(engagementRecipient('email_replied', member('ana'), member('ben'))).toBe('ana');
        const left = member('ana', { leftAt: new Date() });
        expect(engagementRecipient('email_replied', left, member('ben'))).toBe('ben');
        expect(engagementRecipient('email_replied', left, null)).toBeNull();
        expect(engagementRecipient('email_replied', left, member('ben', { leftAt: new Date() }))).toBeNull();
        expect(engagementRecipient('email_opened', member('ana', { notifyEmailOpens: false }), member('ben'))).toBe(
            null,
        );
        expect(engagementRecipient('email_clicked', member('ana', { notifyEmailOpens: false }), null)).toBe('ana');
        // The owner's own setting decides for them.
        expect(engagementRecipient('email_clicked', left, member('ben', { notifyEmailClicks: false }))).toBeNull();
    });
});

import { describe, expect, it } from 'vitest';
import { followAfter, type EarlierSend } from './thread-follow';

const earlier = (over: Partial<EarlierSend>): EarlierSend => ({
    status: 'sent',
    mailboxId: 'mailbox-1',
    mailMessageId: 'message-1',
    ...over,
});

/** The one thread rule a sequence's reply-in-thread step and a queued follow-up both go by. */
describe('followAfter', () => {
    it('answers the earlier send’s stored copy, from its mailbox, once it has gone and been stored', () => {
        expect(followAfter(earlier({}))).toEqual({
            kind: 'reply',
            mailboxId: 'mailbox-1',
            parentMessageId: 'message-1',
        });
    });

    it('waits while the earlier send is gone but not stored yet (the next sync stores it)', () => {
        expect(followAfter(earlier({ mailMessageId: null }))).toEqual({ kind: 'wait' });
    });

    it.each(['scheduled', 'queued', 'sending'] as const)(
        'waits while the earlier send is %s — never out of order',
        (status) => {
            expect(followAfter(earlier({ status, mailMessageId: null }))).toEqual({ kind: 'wait' });
        },
    );

    it.each(['failed', 'cancelled'] as const)('is broken when the earlier send is %s', (status) => {
        expect(followAfter(earlier({ status, mailMessageId: null }))).toEqual({ kind: 'broken', status });
    });
});

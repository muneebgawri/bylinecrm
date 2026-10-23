import type { MailOutboundStatus } from '@bylinecrm/shared';

/**
 * How a message that follows an earlier send goes into that send's thread — one rule for a sequence's
 * reply-in-thread step (P3-3) and a member's queued follow-up. It answers the earlier send's stored copy
 * (`replyToMessageId`): that gives it `In-Reply-To` / `References` and the Gmail thread (`buildMime`,
 * `parentThread`), and its subject the thread's (`Re: …`). So it can only be built once the earlier send has
 * gone and sync has stored it; until then it waits, and never goes out of order or outside the thread.
 */

/** A follower whose earlier send is not stored yet looks again this much later (the next sync stores it). */
export const THREAD_PARENT_WAIT_MS = 5 * 60_000;

/** The earlier send, as far as threading after it is concerned. */
export interface EarlierSend {
    status: MailOutboundStatus;
    mailboxId: string;
    /** Its stored copy, once sync has it. */
    mailMessageId: string | null;
}

export type ThreadFollow =
    /** Ready: answer `parentMessageId`, from the mailbox that sent it (and holds the copy). */
    | { kind: 'reply'; mailboxId: string; parentMessageId: string }
    /** Not gone yet, or gone but not stored yet: try again later (`THREAD_PARENT_WAIT_MS`). */
    | { kind: 'wait' }
    /** It will never go: whatever follows it is called off. */
    | { kind: 'broken'; status: 'failed' | 'cancelled' };

/** Where a message that follows `earlier` in its thread stands. */
export function followAfter(earlier: EarlierSend): ThreadFollow {
    if (earlier.status === 'failed' || earlier.status === 'cancelled') {
        return { kind: 'broken', status: earlier.status };
    }
    if (earlier.status !== 'sent' || earlier.mailMessageId === null) return { kind: 'wait' };
    return { kind: 'reply', mailboxId: earlier.mailboxId, parentMessageId: earlier.mailMessageId };
}

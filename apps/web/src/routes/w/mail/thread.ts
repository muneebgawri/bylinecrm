import type { MailMessageView, MailParticipantView } from '../../../api/types';

/**
 * A thread's view (doc 50 §A): `?thread=<id>` opens it over whatever page is showing — the record
 * page or the record drawer — so a timeline line, a refresh and a shared link land on the same view.
 */
export const THREAD_PARAM = 'thread';

/** The current search with `thread` set (or removed when `threadId` is null), nothing else touched. */
export function withThread(search: string, threadId: string | null): string {
    const params = new URLSearchParams(search);
    if (threadId) params.set(THREAD_PARAM, threadId);
    else params.delete(THREAD_PARAM);
    const text = params.toString();
    return text ? `?${text}` : '';
}

/** Oldest first: a thread reads top to bottom, as it was written. */
export function oldestFirst(messages: readonly MailMessageView[]): MailMessageView[] {
    return [...messages].sort((a, b) => Date.parse(a.sentAt) - Date.parse(b.sentAt));
}

/** "Dana Reyes <dana@acme.com>", or the address alone when there is no name. */
export function participantText(p: Pick<MailParticipantView, 'displayName' | 'address'>): string {
    return p.displayName && p.displayName !== p.address ? `${p.displayName} <${p.address}>` : p.address;
}

/** The message's "To …", "Cc …" lines (the sender is the message's heading). */
export function recipientLines(message: MailMessageView): string[] {
    const lines: string[] = [];
    for (const role of ['to', 'cc', 'bcc'] as const) {
        const list = message.participants.filter((p) => p.role === role);
        if (list.length)
            lines.push(
                `${role === 'to' ? 'To' : role === 'cc' ? 'Cc' : 'Bcc'} ${list.map(participantText).join(', ')}`,
            );
    }
    return lines;
}

/** Who sent it, as a heading: their name, else their address. */
export function senderName(message: MailMessageView): string {
    const from = message.participants.find((p) => p.role === 'from');
    return from?.displayName || from?.address || message.from;
}

/**
 * The person a reply to `message` goes to, and is about: the sender of mail that came in; the
 * first CRM person it was sent to otherwise. Null when the other side is not a person in the CRM.
 */
export function replyPersonId(message: MailMessageView): string | null {
    const side = message.direction === 'inbound' ? ['from'] : ['to', 'cc'];
    return message.participants.find((p) => side.includes(p.role) && p.personId)?.personId ?? null;
}

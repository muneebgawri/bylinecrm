import type { DomainEvent, NotificationKind, NotificationTarget } from '@bylinecrm/shared';

/** The three things a sender hears of an email they sent from the CRM. */
export type EmailEngagementKind = Extract<NotificationKind, 'email_replied' | 'email_clicked' | 'email_opened'>;

/** The member setting that says whether they want each kind. */
export const ENGAGEMENT_SETTING = {
    email_replied: 'notifyEmailReplies',
    email_clicked: 'notifyEmailClicks',
    email_opened: 'notifyEmailOpens',
} as const satisfies Record<EmailEngagementKind, string>;
export type EngagementSetting = (typeof ENGAGEMENT_SETTING)[EmailEngagementKind];

/**
 * What an event tells, about which send, and the notification's target: a reply is about the inbound message (every
 * reply tells), a click or an open about the send (the first tells; the unique row makes the rest nothing).
 * `null` for an event that tells nobody, or one missing its payload.
 */
export function engagementOf(
    event: DomainEvent,
): { kind: EmailEngagementKind; outboundId: string; personIds: string[]; target: NotificationTarget } | null {
    switch (event.type) {
        case 'email.replied':
            return event.reply
                ? {
                      kind: 'email_replied',
                      outboundId: event.reply.inReplyToOutboundId,
                      personIds: event.reply.personIds,
                      target: { type: 'reply', id: event.reply.messageId },
                  }
                : null;
        case 'email.clicked':
        case 'email.opened':
            return event.tracking
                ? {
                      kind: event.type === 'email.clicked' ? 'email_clicked' : 'email_opened',
                      outboundId: event.tracking.outboundId,
                      personIds: event.tracking.personId ? [event.tracking.personId] : [],
                      target: { type: 'email', id: event.tracking.outboundId },
                  }
                : null;
        default:
            return null;
    }
}

interface Member {
    id: string;
    leftAt: Date | null;
    notifyEmailReplies: boolean;
    notifyEmailClicks: boolean;
    notifyEmailOpens: boolean;
}

/**
 * Who hears of it: the send's sender while they are in the workspace; once they have left, the person's owner (if
 * they are in it); nobody otherwise. Whoever it is hears only if they have not turned the kind off.
 */
export function engagementRecipient(
    kind: EmailEngagementKind,
    sender: Member,
    personOwner: Member | null,
): string | null {
    const who = sender.leftAt === null ? sender : personOwner && personOwner.leftAt === null ? personOwner : null;
    return who && who[ENGAGEMENT_SETTING[kind]] ? who.id : null;
}

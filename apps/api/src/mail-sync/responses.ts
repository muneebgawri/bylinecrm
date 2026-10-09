import { BLOCKLIST_SCOPES, MAIL_DIRECTIONS, MAIL_PARTICIPANT_ROLES, MAIL_SYNC_STATUSES } from '@bylinecrm/shared';
import { z } from 'zod';
import { dateTime, id, named, page } from '../openapi/responses';

/** Mail sync (P2-2) as the API returns it. */

const participant = z.object({
    role: z.enum(MAIL_PARTICIPANT_ROLES),
    address: z.string(),
    displayName: z.string(),
    personId: id.nullable().meta({ description: 'The person this address is, when it is one.' }),
    memberId: id.nullable().meta({ description: 'The workspace member this address is, when it is one.' }),
});

export const mailThreadSummary = named(
    'MailThreadSummary',
    z.object({
        id,
        mailboxId: id,
        subject: z.string().meta({ description: "The thread's first message's subject." }),
        messageCount: z.number().int(),
        lastMessageAt: dateTime,
        lastMessage: z.object({
            direction: z.enum(MAIL_DIRECTIONS),
            from: z.string(),
            snippet: z.string(),
            sentAt: dateTime,
        }),
    }),
);

export const mailThreadPage = named('MailThreadPage', page(mailThreadSummary));

export const mailMessageView = named(
    'MailMessage',
    z.object({
        id,
        direction: z.enum(MAIL_DIRECTIONS),
        from: z.string(),
        subject: z.string(),
        snippet: z.string(),
        sentAt: dateTime,
        participants: z.array(participant),
        hasAttachments: z.boolean(),
        bodyText: z
            .string()
            .nullable()
            .meta({ description: 'Null when the caller may see this mail only as metadata.' }),
        bodyHtml: z.string().nullable().meta({
            description: 'Sanitised (allowlist; no images, scripts or styles). Null when absent or not visible.',
        }),
        bodyTruncated: z.boolean(),
        rfc822MessageId: z.string().nullable(),
        inReplyTo: z.string().nullable(),
    }),
);

export const mailThreadView = named(
    'MailThread',
    z.object({
        id,
        mailboxId: id,
        subject: z.string(),
        messageCount: z.number().int(),
        lastMessageAt: dateTime,
        bodiesVisible: z.boolean().meta({
            description:
                "False when the thread is in another member's personal mailbox: subject, snippet and participants only.",
        }),
        messages: z.array(mailMessageView),
    }),
);

const syncError = z.object({ code: z.string(), message: z.string(), at: dateTime });

export const mailboxSyncView = named(
    'MailboxSync',
    z.object({
        mailboxId: id,
        status: z.enum(MAIL_SYNC_STATUSES),
        lastSyncedAt: dateTime.nullable(),
        fullSyncCompletedAt: dateTime.nullable().meta({ description: 'When the first import finished.' }),
        lastError: syncError.nullable().meta({ description: 'Why the last run stopped or was skipped.' }),
    }),
);

export const mailboxSyncTriggered = named(
    'MailboxSyncTriggered',
    z.object({
        sync: mailboxSyncView,
        queued: z.boolean().meta({ description: 'False when a run for this mailbox is already queued or running.' }),
    }),
);

export const blocklistEntryView = named(
    'BlocklistEntry',
    z.object({
        id,
        value: z.string().meta({ description: '`someone@example.com` or `@example.com`.' }),
        scope: z.enum(BLOCKLIST_SCOPES),
        createdAt: dateTime,
    }),
);

export type MailThreadSummary = z.output<typeof mailThreadSummary>;
export type MailThreadView = z.output<typeof mailThreadView>;
export type MailMessageView = z.output<typeof mailMessageView>;
export type MailboxSyncView = z.output<typeof mailboxSyncView>;
export type MailboxSyncTriggered = z.output<typeof mailboxSyncTriggered>;
export type BlocklistEntryView = z.output<typeof blocklistEntryView>;

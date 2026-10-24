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
        mailboxIds: z.array(id).meta({
            description: 'Every mailbox holding a copy of a message in the thread (#107): one email, many mailboxes.',
        }),
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
        mailboxIds: z.array(id).meta({ description: 'The mailboxes holding a copy of this message (#107).' }),
        bodiesVisible: z.boolean().meta({
            description:
                'False when the caller holds no copy and every copy is in another member’s personal mailbox: subject, snippet and participants only.',
        }),
        direction: z.enum(MAIL_DIRECTIONS).meta({
            description: "The workspace's view: outbound when one of the workspace's mailboxes sent it.",
        }),
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
        mailboxIds: z
            .array(id)
            .meta({ description: 'Every mailbox holding a copy of a message in the thread (#107).' }),
        subject: z.string(),
        messageCount: z.number().int(),
        lastMessageAt: dateTime,
        bodiesVisible: z.boolean().meta({
            description: "True when every message's bodies are visible to the caller (each message says for itself).",
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

export const blocklistEntryCreated = named(
    'BlocklistEntryCreated',
    z.object({
        entry: blocklistEntryView,
        purged: z.object({ messages: z.number().int(), threads: z.number().int() }).meta({
            description:
                'Stored mail the new entry fully covers, deleted with its timeline entries, and threads left empty. Removing the entry later does not bring it back.',
        }),
    }),
);

export type MailThreadSummary = z.output<typeof mailThreadSummary>;
export type MailThreadView = z.output<typeof mailThreadView>;
export type MailMessageView = z.output<typeof mailMessageView>;
export type MailboxSyncView = z.output<typeof mailboxSyncView>;
export type MailboxSyncTriggered = z.output<typeof mailboxSyncTriggered>;
export type BlocklistEntryView = z.output<typeof blocklistEntryView>;
export type BlocklistEntryCreated = z.output<typeof blocklistEntryCreated>;

/** One message a service inbox holds, as an integration reads it (SVC-1). */
export const serviceMailMessage = named(
    'ServiceMailMessage',
    z.object({
        id,
        from: z.string().meta({ description: 'The sender, lower case.' }),
        subject: z.string(),
        text: z.string().meta({ description: 'The plain-text body (empty when the message had none).' }),
        sentAt: dateTime.meta({ description: "The message's own Date header: sender-controlled, never page on it." }),
        storedAt: dateTime.meta({ description: 'When the CRM stored it: monotonic, what the page is ordered by.' }),
    }),
);
export type ServiceMailMessage = z.infer<typeof serviceMailMessage>;
export const serviceMailPage = named('ServiceMailPage', page(serviceMailMessage));

/** How much each sender sent on one UTC day (SVC-1): mail already sent, so a scheduled send counts once it goes. */
export const sentCountsView = named(
    'SentCounts',
    z.object({
        day: z.string().meta({ description: '`YYYY-MM-DD`, UTC.' }),
        complete: z.boolean().meta({ description: 'The day has ended: its counts will not grow.' }),
        senders: z.array(
            z.object({
                address: z.string(),
                count: z.number().int(),
                lastSentAt: dateTime,
            }),
        ),
    }),
);
export type SentCountsView = z.infer<typeof sentCountsView>;

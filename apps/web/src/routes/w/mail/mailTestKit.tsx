import type {
    EmailTemplateView,
    MailDraftView,
    MailboxView,
    MailMessageView,
    MailOutboundView,
    MailThreadView,
} from '../../../api/types';
import { json, type FakeRoute } from '../settings/settingsTestKit';

/** The mail specs' shared rows: one member (`m-1`, the test kit's membership) writing to Dana. */
export const WS = 'ws-1';
export const PERSON = { id: '0b1e0000-0000-4000-8000-0000000000d1', name: 'Dana Reyes', email: 'dana@acme.com' };
const AT = '2026-10-09T08:00:00.000Z';

export const mailbox = (over: Partial<MailboxView> = {}): MailboxView => ({
    id: 'mb-1',
    ownerMemberId: 'm-1',
    email: 'kate@example.com',
    label: null,
    purpose: 'personal',
    transport: 'gmail',
    credentialSource: 'oauth',
    status: 'connected',
    grantedScopes: [],
    lastError: null,
    connectedAt: AT,
    createdAt: AT,
    updatedAt: AT,
    ...over,
});

const member = { kind: 'member' as const, id: 'm-1' };
export const template = (over: Partial<EmailTemplateView> = {}): EmailTemplateView => ({
    id: 't-1',
    name: 'Follow-up after a reply',
    kind: 'personal',
    subject: 'About {{company.name}}',
    body: {
        type: 'doc',
        content: [
            {
                type: 'paragraph',
                content: [
                    { type: 'text', text: 'Hi ' },
                    { type: 'variable', attrs: { path: 'person.firstName' } },
                    { type: 'text', text: ', lead with ' },
                    { type: 'variable', attrs: { path: 'custom.lastOutlet' } },
                ],
            },
        ],
    },
    version: 1,
    createdBy: member,
    updatedBy: member,
    createdAt: AT,
    updatedAt: AT,
    deletedAt: null,
    ...over,
});

export const outbound = (over: Partial<MailOutboundView> = {}): MailOutboundView => ({
    id: 'out-1',
    mailboxId: 'mb-1',
    status: 'queued',
    subject: 'Hello',
    to: [PERSON.email],
    cc: [],
    bcc: [],
    personId: PERSON.id,
    dealId: null,
    templateId: null,
    replyToMessageId: null,
    followsOutboundId: null,
    senderMemberId: 'm-1',
    canChange: true,
    canRetry: false,
    rfc822MessageId: 'out-1@bylinecrm',
    mailMessageId: null,
    threadId: null,
    attempts: 0,
    error: null,
    sendAt: null,
    senderTimeZone: null,
    recipientTimeZone: null,
    cancelledAt: null,
    createdAt: AT,
    sentAt: null,
    tracking: { clicks: 0, uniqueClicks: 0, opens: 0 },
    ...over,
});

export const message = (over: Partial<MailMessageView> = {}): MailMessageView => ({
    id: 'msg-1',
    mailboxIds: ['mb-1'],
    bodiesVisible: true,
    direction: 'inbound',
    from: PERSON.email,
    subject: 'Intro',
    snippet: 'Thanks for reaching out',
    sentAt: AT,
    participants: [
        { role: 'from', address: PERSON.email, displayName: PERSON.name, personId: PERSON.id, memberId: null },
        { role: 'to', address: 'kate@example.com', displayName: 'Kate Morgan', personId: null, memberId: 'm-1' },
    ],
    hasAttachments: false,
    bodyText: 'Thanks for reaching out',
    bodyHtml: '<p>Thanks for reaching out</p>',
    bodyTruncated: false,
    rfc822MessageId: 'a@mail',
    inReplyTo: null,
    ...over,
});

export const thread = (over: Partial<MailThreadView> = {}): MailThreadView => ({
    id: 'th-1',
    mailboxIds: ['mb-1'],
    subject: 'Intro',
    messageCount: 1,
    lastMessageAt: AT,
    bodiesVisible: true,
    messages: [message()],
    ...over,
});

/** The mailbox list the composer reads, answered with `list`. */
export const mailboxesRoute =
    (list: MailboxView[]): FakeRoute =>
    (r) =>
        r.method === 'GET' && r.url.endsWith('/mailboxes') ? json(list) : undefined;

/** Whether a request is the record-sends list (`GET /mail/messages?…`), not one send (`messages/:id`). */
export const isRecordSends = (r: { method: string; url: string }) =>
    r.method === 'GET' && /\/mail\/messages\?/.test(r.url);

/** Every request for a record's sends (#104) answers with these rows. */
export const recordSendsRoute =
    (items: MailOutboundView[] = []): FakeRoute =>
    (r) =>
        isRecordSends(r) ? json({ items, nextCursor: null }) : undefined;

/** One of the caller's drafts (Dana's, no deal), at version 1. */
export const mailDraft = (over: Partial<MailDraftView> = {}): MailDraftView => ({
    id: '0b1e0000-0000-4000-8000-0000000000f1',
    personId: PERSON.id,
    dealId: null,
    replyToMessageId: null,
    threadId: null,
    content: {},
    version: 1,
    createdAt: AT,
    updatedAt: AT,
    ...over,
});

/** Whether a request is the record-drafts list (`GET /mail/drafts?…`). */
export const isDraftList = (r: { method: string; url: string }) => r.method === 'GET' && /\/mail\/drafts\?/.test(r.url);

/** Every request for a record's drafts answers with these. */
export const draftsRoute =
    (items: MailDraftView[] = []): FakeRoute =>
    (r) =>
        isDraftList(r) ? json({ items, nextCursor: null }) : undefined;

/** A timeline with no entries; the record's other reads answered empty. */
export const quietRecordRoutes: FakeRoute[] = [
    (r) => (r.url.includes('/timeline') ? json({ items: [], nextCursor: null }) : undefined),
    (r) => (r.url.endsWith('/members/summary') ? json([{ memberId: 'm-1', name: 'Kate Morgan' }]) : undefined),
];

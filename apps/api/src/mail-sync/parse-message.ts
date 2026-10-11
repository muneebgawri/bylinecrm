import type { MailParticipantRole } from '@bylinecrm/shared';
import addressparser from 'addressparser';
import libmime from 'libmime';
import type { GmailHeader, GmailPart, GmailRawMessage } from './gmail.port';
import { capBody, decodeEntities, sanitizeMailHtml, textFromHtml } from './html';
import { MAIL_LINE_MAX_CHARS } from './mail-sync.constants';

/**
 * A Gmail message (`format=full`) → what sync stores (P2-2). Pure: no I/O, so the HTTP adapter's
 * answers and the test fake's go through the same code.
 */

export interface ParsedParticipant {
    role: MailParticipantRole;
    /** Lower case. */
    address: string;
    displayName: string;
}

export interface ParsedMessage {
    providerMessageId: string;
    providerThreadId: string;
    labelIds: string[];
    rfc822MessageId: string | null;
    /**
     * The CRM's own `X-BylineCRM-Id` on a message it sent (P2-3a), a send id; null on any other
     * message or when the value is not a UUID. Gmail keeps this header when it rewrites Message-ID.
     */
    crmId: string | null;
    inReplyTo: string | null;
    references: string[];
    subject: string;
    /** The sender's address, lower case; `''` when the message names none. */
    from: string;
    participants: ParsedParticipant[];
    sentAt: Date;
    snippet: string;
    bodyText: string;
    bodyHtml: string | null;
    bodyTruncated: boolean;
    hasAttachments: boolean;
    /** A delivery status notification's content (RFC 3464, P3-2); null on any other message. */
    bounce: ParsedBounce | null;
}

/** What a bounce report says: each failed address with its status, and the send it answers when it names one. */
export interface ParsedBounce {
    recipients: { address: string; permanent: boolean; status: string | null }[];
    /** The original message's `X-BylineCRM-Id`, from the report's copy of its headers. */
    crmId: string | null;
}

const ADDRESS_HEADERS: readonly [string, MailParticipantRole][] = [
    ['from', 'from'],
    ['to', 'to'],
    ['cc', 'cc'],
    ['bcc', 'bcc'],
];

export function parseGmailMessage(raw: GmailRawMessage): ParsedMessage {
    const headers = raw.payload.headers ?? [];
    const participants = ADDRESS_HEADERS.flatMap(([name, role]) => addresses(headerValues(headers, name), role));
    const from = participants.find((p) => p.role === 'from')?.address ?? '';
    const bodies = collectBodies(raw.payload);
    const html = bodies.html !== null ? capBody(sanitizeMailHtml(bodies.html)) : null;
    const text = capBody(bodies.text ?? (bodies.html !== null ? textFromHtml(bodies.html) : ''));

    return {
        providerMessageId: raw.id,
        providerThreadId: raw.threadId,
        labelIds: raw.labelIds ?? [],
        rfc822MessageId: messageId(headerValue(headers, 'message-id')),
        crmId: crmIdOf(headerValue(headers, 'x-bylinecrm-id')),
        inReplyTo: messageId(headerValue(headers, 'in-reply-to')),
        references: messageIds(headerValue(headers, 'references')),
        subject: line(libmime.decodeWords(headerValue(headers, 'subject') ?? '')),
        from,
        participants,
        sentAt: sentAt(headerValue(headers, 'date'), raw.internalDate),
        snippet: line(decodeEntities(raw.snippet ?? '')),
        bodyText: text.value,
        bodyHtml: html?.value ?? null,
        bodyTruncated: text.truncated || (html?.truncated ?? false),
        hasAttachments: bodies.hasAttachments,
        bounce: bounceOf(raw.payload, headers),
    };
}

/**
 * A bounce report's content, or null when the message is not one. A report is recognised by its
 * structure — `multipart/report; report-type=delivery-status` (RFC 3464) — or by Gmail's own
 * `X-Failed-Recipients` header, never by its subject or wording. Each `Final-Recipient` block of the
 * `message/delivery-status` part gives an address and its `Status` (`5.x.x` permanent, `4.x.x`
 * transient); with no such part, `X-Failed-Recipients` names the addresses and the report's text its
 * status. The original's `X-BylineCRM-Id` is read from the returned headers when they are included.
 */
function bounceOf(root: GmailPart, headers: GmailHeader[]): ParsedBounce | null {
    const contentType = (headerValue(headers, 'content-type') ?? root.mimeType).toLowerCase();
    const isReport = /multipart\/report/.test(contentType) && /report-type\s*=\s*"?delivery-status/.test(contentType);
    const failedHeader = headerValues(headers, 'x-failed-recipients')
        .flatMap((v) => v.split(','))
        .map((a) => a.trim().toLowerCase())
        .filter((a) => a.includes('@'));
    if (!isReport && failedHeader.length === 0) return null;

    const parts: GmailPart[] = [];
    const walk = (part: GmailPart): void => {
        parts.push(part);
        part.parts?.forEach(walk);
    };
    walk(root);
    const textOf = (part: GmailPart) =>
        part.body?.data ? Buffer.from(part.body.data, 'base64url').toString('utf8') : '';

    const recipients: ParsedBounce['recipients'] = [];
    const status = parts.find((p) => p.mimeType.toLowerCase() === 'message/delivery-status');
    if (status) {
        for (const block of textOf(status).split(/\r?\n\s*\r?\n/)) {
            const recipient = /^final-recipient:\s*[^;]*;\s*(\S+@\S+)\s*$/im.exec(block)?.[1];
            if (!recipient) continue;
            const code = /^status:\s*([245]\.\d{1,3}\.\d{1,3})/im.exec(block)?.[1] ?? null;
            recipients.push({
                address: recipient.toLowerCase(),
                permanent: code?.startsWith('5.') ?? true,
                status: code,
            });
        }
    }
    if (recipients.length === 0) {
        const text = parts.map(textOf).join('\n');
        const code = /\b([45]\.\d{1,3}\.\d{1,3})\b/.exec(text)?.[1] ?? null;
        for (const address of failedHeader) {
            recipients.push({ address, permanent: code ? code.startsWith('5.') : true, status: code });
        }
    }
    if (recipients.length === 0) return null;

    // The report's own headers never carry the original's id; only a returned copy of them does.
    let crmId: string | null = null;
    for (const part of parts.slice(1)) {
        const type = part.mimeType.toLowerCase();
        const returned =
            type === 'text/rfc822-headers' || type === 'message/rfc822'
                ? (/^x-bylinecrm-id:\s*(\S+)/im.exec(textOf(part))?.[1] ?? null)
                : headerValue(part.headers ?? [], 'x-bylinecrm-id');
        crmId = crmIdOf(returned);
        if (crmId) break;
    }
    return { recipients, crmId };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function crmIdOf(value: string | null): string | null {
    const trimmed = value?.trim() ?? '';
    return UUID.test(trimmed) ? trimmed.toLowerCase() : null;
}

function headerValues(headers: GmailHeader[], name: string): string[] {
    return headers.filter((h) => h.name.toLowerCase() === name).map((h) => h.value);
}

function headerValue(headers: GmailHeader[], name: string): string | null {
    return headerValues(headers, name)[0] ?? null;
}

/** Every address in the headers, groups flattened; display names decoded; one per address and role. */
function addresses(values: string[], role: MailParticipantRole): ParsedParticipant[] {
    const seen = new Set<string>();
    const out: ParsedParticipant[] = [];
    const visit = (entry: addressparser.ParsedAddress): void => {
        if (entry.group) {
            entry.group.forEach(visit);
            return;
        }
        const address = entry.address?.trim().toLowerCase();
        if (!address || !address.includes('@') || seen.has(address)) return;
        seen.add(address);
        out.push({ role, address, displayName: line(libmime.decodeWords(entry.name ?? '')) });
    };
    for (const value of values) addressparser(value).forEach(visit);
    return out;
}

/** `<id@host>` → `id@host`; anything without angle brackets is taken as written. */
function messageId(value: string | null): string | null {
    if (!value) return null;
    const match = /<([^>]+)>/.exec(value);
    const id = (match?.[1] ?? value).trim();
    return id === '' ? null : id;
}

function messageIds(value: string | null): string[] {
    if (!value) return [];
    const bracketed = [...value.matchAll(/<([^>]+)>/g)].map((m) => m[1]!.trim()).filter((id) => id !== '');
    return bracketed.length > 0 ? bracketed : value.split(/\s+/).filter((id) => id !== '');
}

/** The `Date` header when it parses; otherwise when Gmail received the message. */
function sentAt(date: string | null, internalDate: string | undefined): Date {
    const fromHeader = date ? new Date(date) : null;
    if (fromHeader && !Number.isNaN(fromHeader.getTime())) return fromHeader;
    const received = internalDate ? new Date(Number(internalDate)) : null;
    return received && !Number.isNaN(received.getTime()) ? received : new Date(0);
}

/** One line of text: whitespace runs collapsed, cut to the stored length. */
function line(value: string): string {
    return value.replace(/\s+/g, ' ').trim().slice(0, MAIL_LINE_MAX_CHARS);
}

interface Bodies {
    text: string | null;
    html: string | null;
    hasAttachments: boolean;
}

/**
 * The first inline `text/plain` and `text/html` parts, depth first (so a `multipart/alternative`
 * inside a `multipart/mixed` is found), and whether any part is an attachment.
 */
function collectBodies(root: GmailPart): Bodies {
    const found: Bodies = { text: null, html: null, hasAttachments: false };
    const walk = (part: GmailPart): void => {
        const isAttachment = Boolean(part.filename) || Boolean(part.body?.attachmentId);
        if (isAttachment) {
            found.hasAttachments = true;
            return;
        }
        const type = part.mimeType.toLowerCase();
        if (type === 'text/plain' && found.text === null && part.body?.data) {
            found.text = decodePart(part);
        } else if (type === 'text/html' && found.html === null && part.body?.data) {
            found.html = decodePart(part);
        }
        part.parts?.forEach(walk);
    };
    walk(root);
    return found;
}

/** A part's base64url body in its declared charset (UTF-8 when none or unknown). */
function decodePart(part: GmailPart): string {
    const bytes = Buffer.from(part.body!.data!, 'base64url');
    const contentType = headerValue(part.headers ?? [], 'content-type') ?? '';
    const charset = /charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType)?.[1] ?? 'utf-8';
    try {
        return new TextDecoder(charset).decode(bytes);
    } catch {
        return new TextDecoder('utf-8').decode(bytes);
    }
}

import { createHash, randomUUID } from 'node:crypto';
import libmime from 'libmime';
import { MAIL_CRM_ID_HEADER, MAIL_MESSAGE_ID_DOMAIN } from './mail-send.constants';

/**
 * The one MIME builder (P2-3): what the CRM sends, as RFC 5322 text Gmail accepts as `raw`. Pure —
 * the same input always gives the same bytes (the boundary is derived from the Message-ID), so a
 * message is built once, stored, and sent as stored.
 *
 * `multipart/alternative` with a text part then an HTML part (RFC 2046: last is preferred), both
 * UTF-8 and base64 in 76-character lines; CRLF line endings throughout. Header values are 7-bit:
 * non-ASCII text is encoded as RFC 2047 words, and line breaks inside a value are collapsed to a
 * space so no value can start a header of its own.
 */

export interface MimeAddress {
    address: string;
    name?: string | null | undefined;
}

export interface MimeInput {
    from: MimeAddress;
    to: MimeAddress[];
    cc?: MimeAddress[] | undefined;
    bcc?: MimeAddress[] | undefined;
    subject: string;
    text: string;
    html: string;
    /** Without angle brackets: `<uuid>@bylinecrm`. */
    messageId: string;
    /** The send's id, written as `X-BylineCRM-Id` — the header Gmail keeps when it rewrites Message-ID. */
    crmId: string;
    /** The parent's Message-ID, without angle brackets, when this is a reply. */
    inReplyTo?: string | null | undefined;
    /** The parent's References then the parent, oldest first, without angle brackets. */
    references?: readonly string[] | undefined;
    /**
     * Outreach only (P3-1, FR-CRMS-7): the recipient's one-click unsubscribe URL, written as
     * `List-Unsubscribe` with `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058). Personal
     * 1:1 mail carries neither.
     */
    listUnsubscribe?: { url: string } | undefined;
    date: Date;
}

const CRLF = '\r\n';
/** An encoded word is at most 75 characters (RFC 2047 §2); leave room for the header name. */
const ENCODED_WORD_MAX = 52;
/** Base64 body lines (RFC 2045 §6.8). */
const BASE64_LINE = 76;

/** A new Message-ID on our domain-agnostic form: `<uuid>@bylinecrm`, unique per message. */
export function newMessageId(): string {
    return `${randomUUID()}@${MAIL_MESSAGE_ID_DOMAIN}`;
}

/** A reply's subject: the parent's, prefixed `Re:` once. */
export function replySubject(parent: string): string {
    const trimmed = parent.trim();
    if (/^re:/i.test(trimmed)) return trimmed;
    return trimmed === '' ? 'Re:' : `Re: ${trimmed}`;
}

export function buildMime(input: MimeInput): string {
    const boundary = `bylinecrm-${createHash('sha256').update(input.messageId).digest('hex').slice(0, 32)}`;
    const headers: [string, string][] = [
        ['From', address(input.from)],
        ['To', input.to.map(address).join(', ')],
        ...(input.cc?.length ? [['Cc', input.cc.map(address).join(', ')] as [string, string]] : []),
        ...(input.bcc?.length ? [['Bcc', input.bcc.map(address).join(', ')] as [string, string]] : []),
        ['Subject', text(input.subject)],
        ['Date', rfc5322Date(input.date)],
        ['Message-ID', `<${input.messageId}>`],
        [MAIL_CRM_ID_HEADER, oneLine(input.crmId)],
        ...(input.inReplyTo ? [['In-Reply-To', `<${input.inReplyTo}>`] as [string, string]] : []),
        ...(input.references?.length
            ? [['References', input.references.map((id) => `<${id}>`).join(' ')] as [string, string]]
            : []),
        ...(input.listUnsubscribe
            ? ([
                  ['List-Unsubscribe', `<${oneLine(input.listUnsubscribe.url)}>`],
                  ['List-Unsubscribe-Post', 'List-Unsubscribe=One-Click'],
              ] as [string, string][])
            : []),
        ['MIME-Version', '1.0'],
        ['Content-Type', `multipart/alternative; boundary="${boundary}"`],
    ];
    return [
        ...headers.map(([name, value]) => fold(`${name}: ${value}`)),
        '',
        `--${boundary}`,
        ...part('text/plain', input.text),
        `--${boundary}`,
        ...part('text/html', input.html),
        `--${boundary}--`,
        '',
    ].join(CRLF);
}

function part(contentType: string, body: string): string[] {
    const encoded = Buffer.from(body.replace(/\r?\n/g, CRLF), 'utf8').toString('base64');
    const lines = encoded.match(new RegExp(`.{1,${BASE64_LINE}}`, 'g')) ?? [''];
    return [`Content-Type: ${contentType}; charset="utf-8"`, 'Content-Transfer-Encoding: base64', '', ...lines];
}

/** A header value as one line: breaks collapsed, non-ASCII as encoded words. */
function text(value: string): string {
    return libmime.encodeWords(oneLine(value), 'B', ENCODED_WORD_MAX);
}

function oneLine(value: string): string {
    return value
        .replace(/[\r\n]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * `"Display Name" <address>`, or the bare address. A name with only safe ASCII is quoted (with
 * `"` and `\` escaped); a name with any other character is one or more encoded words.
 */
function address(entry: MimeAddress): string {
    const addr = oneLine(entry.address);
    const name = entry.name ? oneLine(entry.name) : '';
    if (name === '') return addr;
    if (/^[\x20-\x7e]*$/.test(name)) return `"${name.replace(/(["\\])/g, '\\$1')}" <${addr}>`;
    return `${libmime.encodeWords(name, 'B', ENCODED_WORD_MAX)} <${addr}>`;
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** RFC 5322 §3.3 date in UTC: `Sat, 10 Oct 2026 09:30:00 +0000`. */
function rfc5322Date(date: Date): string {
    const two = (n: number) => String(n).padStart(2, '0');
    return (
        `${DAYS[date.getUTCDay()]}, ${two(date.getUTCDate())} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()} ` +
        `${two(date.getUTCHours())}:${two(date.getUTCMinutes())}:${two(date.getUTCSeconds())} +0000`
    );
}

/** Folds a header line at spaces so no line exceeds 78 characters where it can be helped (RFC 5322 §2.2.3). */
function fold(line: string): string {
    if (line.length <= 78) return line;
    const out: string[] = [];
    let current = '';
    for (const word of line.split(' ')) {
        if (current !== '' && current.length + 1 + word.length > 78) {
            out.push(current);
            current = ` ${word}`;
        } else {
            current = current === '' ? word : `${current} ${word}`;
        }
    }
    out.push(current);
    return out.join(CRLF);
}

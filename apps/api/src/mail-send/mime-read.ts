import type { GmailPart, GmailRawMessage } from '../mail-sync/gmail.port';

/** How much of the text the stored copy's preview holds (Gmail's snippet is about this long). */
const SNIPPET_CHARS = 200;

/**
 * A message `buildMime` wrote, in Gmail's `format=full` shape (TRANS-1), so a send that went through SMTP2Go is
 * stored by sync's one writer exactly as a Gmail send's copy is. Reads only what the builder writes: a header
 * block, then one part or a `multipart/alternative` of base64 parts — never mail from outside.
 */
export function gmailShapeOf(raw: string, ids: { id: string; threadId: string; sentAt: Date }): GmailRawMessage {
    const [head, ...rest] = raw.split('\r\n\r\n');
    const headers = head!
        .replace(/\r\n[ \t]+/g, ' ')
        .split('\r\n')
        .map((line) => {
            const at = line.indexOf(':');
            return { name: line.slice(0, at), value: line.slice(at + 1).trim() };
        });
    const contentType = headers.find((h) => h.name.toLowerCase() === 'content-type')?.value ?? 'text/plain';
    const boundary = /boundary="([^"]+)"/.exec(contentType)?.[1];
    const body = rest.join('\r\n\r\n');
    let text = '';
    let payload: GmailPart;
    if (!boundary) {
        const encoded = /base64/i.test(headers.find((h) => /^content-transfer-encoding$/i.test(h.name))?.value ?? '');
        text = encoded ? Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8') : body;
        payload = { mimeType: contentType.split(';')[0]!.trim(), headers, body: { data: b64(text) } };
    } else {
        const parts: GmailPart[] = body
            .split(`--${boundary}`)
            .slice(1, -1)
            .map((chunk) => {
                const [partHead, ...partBody] = chunk.replace(/^\r\n/, '').split('\r\n\r\n');
                const type = /content-type:\s*([^;\r\n]+)/i.exec(partHead!)?.[1]?.trim() ?? 'text/plain';
                const decoded = Buffer.from(partBody.join('').replace(/\r\n/g, ''), 'base64').toString('utf8');
                if (type === 'text/plain') text = decoded;
                return { mimeType: type, body: { data: b64(decoded) } };
            });
        payload = { mimeType: 'multipart/alternative', headers, parts };
    }
    return {
        id: ids.id,
        threadId: ids.threadId,
        labelIds: ['SENT'],
        snippet: text.replace(/\s+/g, ' ').trim().slice(0, SNIPPET_CHARS),
        internalDate: String(ids.sentAt.getTime()),
        payload,
    };
}

function b64(value: string): string {
    return Buffer.from(value).toString('base64url');
}

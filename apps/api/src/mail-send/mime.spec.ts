import libmime from 'libmime';
import { describe, expect, it } from 'vitest';
import { buildMime, newMessageId, replySubject, type MimeInput } from './mime';

const base: MimeInput = {
    from: { address: 'kate@pinion.example', name: 'Kate Morgan' },
    to: [{ address: 'dana@acme.example', name: 'Dana Reyes' }],
    subject: 'Pricing for the Series B',
    text: 'Hi Dana,\n\nAttached.',
    html: '<p>Hi Dana,</p><p>Attached.</p>',
    messageId: '0190a1b2-c3d4-7e5f-8a6b-1c2d3e4f5a6b@bylinecrm',
    crmId: '0190a1b2-c3d4-7e5f-8a6b-bbbbbbbbbbbb',
    date: new Date('2026-10-10T09:30:00.000Z'),
};

/** The header block of a MIME message, unfolded, as name → value. */
function headersOf(mime: string): Map<string, string> {
    const block = mime.split('\r\n\r\n')[0]!.replace(/\r\n[ \t]+/g, ' ');
    return new Map(
        block.split('\r\n').map((line) => {
            const at = line.indexOf(':');
            return [line.slice(0, at).toLowerCase(), line.slice(at + 1).trim()];
        }),
    );
}

/** The decoded body of the part with this content type. */
function partBody(mime: string, contentType: string): string {
    const boundary = /boundary="([^"]+)"/.exec(mime)![1]!;
    const part = mime.split(`--${boundary}`).find((p) => p.toLowerCase().includes(`content-type: ${contentType}`))!;
    const body = part.split('\r\n\r\n').slice(1).join('\r\n\r\n').trim();
    return Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8');
}

describe('FR-CRMS-2 the MIME builder', () => {
    it('writes RFC 5322 headers: from, to, subject, date, our Message-ID, MIME version', () => {
        const mime = buildMime(base);
        const h = headersOf(mime);
        expect(h.get('from')).toBe('"Kate Morgan" <kate@pinion.example>');
        expect(h.get('to')).toBe('"Dana Reyes" <dana@acme.example>');
        expect(h.get('subject')).toBe('Pricing for the Series B');
        expect(h.get('date')).toBe('Sat, 10 Oct 2026 09:30:00 +0000');
        expect(h.get('message-id')).toBe('<0190a1b2-c3d4-7e5f-8a6b-1c2d3e4f5a6b@bylinecrm>');
        expect(h.get('mime-version')).toBe('1.0');
        expect(h.get('content-type')).toMatch(/^multipart\/alternative; boundary="[^"]+"$/);
        expect(h.has('in-reply-to')).toBe(false);
        expect(h.has('references')).toBe(false);
    });

    it('stamps our own X-BylineCRM-Id, which Gmail keeps when it rewrites the Message-ID (#87)', () => {
        const crmId = '0190a1b2-c3d4-7e5f-8a6b-aaaaaaaaaaaa';
        const h = headersOf(buildMime({ ...base, crmId }));
        expect(h.get('x-bylinecrm-id')).toBe(crmId);
        expect(h.get('message-id')).toBe('<0190a1b2-c3d4-7e5f-8a6b-1c2d3e4f5a6b@bylinecrm>');
    });

    it('uses CRLF line endings and no line over 998 characters', () => {
        const mime = buildMime({ ...base, html: `<p>${'x'.repeat(5000)}</p>` });
        expect(mime.replace(/\r\n/g, '')).not.toContain('\n');
        for (const line of mime.split('\r\n')) expect(line.length).toBeLessThanOrEqual(998);
    });

    it('carries a text and an HTML alternative, text first, both UTF-8 base64', () => {
        const mime = buildMime({ ...base, text: 'Grüße — 你好', html: '<p>Grüße — 你好</p>' });
        expect(mime.indexOf('Content-Type: text/plain')).toBeLessThan(mime.indexOf('Content-Type: text/html'));
        expect(mime).toContain('Content-Type: text/plain; charset="utf-8"');
        expect(mime).toContain('Content-Transfer-Encoding: base64');
        expect(partBody(mime, 'text/plain')).toBe('Grüße — 你好');
        expect(partBody(mime, 'text/html')).toBe('<p>Grüße — 你好</p>');
    });

    it('encodes non-ASCII subjects and display names as RFC 2047 words, ASCII ones as written', () => {
        const mime = buildMime({
            ...base,
            subject: 'Prix — série B',
            to: [{ address: 'zoe@acme.example', name: 'Zoë Ünal' }],
        });
        const h = headersOf(mime);
        expect(h.get('subject')).toContain('=?UTF-8?');
        expect(libmime.decodeWords(h.get('subject')!)).toBe('Prix — série B');
        expect(libmime.decodeWords(h.get('to')!)).toBe('Zoë Ünal <zoe@acme.example>');
        // The header block is 7-bit: every non-ASCII character is inside an encoded word.
        expect([...mime.split('\r\n\r\n')[0]!].every((c) => c.charCodeAt(0) < 128)).toBe(true);
    });

    it('quotes a display name with specials and never lets a header value break the header block', () => {
        const mime = buildMime({
            ...base,
            from: { address: 'kate@pinion.example', name: 'Morgan, Kate "KM"' },
            subject: 'Line one\r\nBcc: attacker@evil.example',
        });
        const h = headersOf(mime);
        expect(h.get('from')).toBe('"Morgan, Kate \\"KM\\"" <kate@pinion.example>');
        expect(h.has('bcc')).toBe(false);
        expect(h.get('subject')).toBe('Line one Bcc: attacker@evil.example');
    });

    it('lists cc and bcc when given; Gmail strips Bcc from what recipients see', () => {
        const mime = buildMime({
            ...base,
            cc: [{ address: 'sam@acme.example' }],
            bcc: [{ address: 'archive@pinion.example' }],
        });
        const h = headersOf(mime);
        expect(h.get('cc')).toBe('sam@acme.example');
        expect(h.get('bcc')).toBe('archive@pinion.example');
    });

    it('threads a reply: In-Reply-To is the parent, References its chain then the parent', () => {
        const mime = buildMime({
            ...base,
            inReplyTo: 'root@acme.example',
            references: ['first@acme.example', 'root@acme.example'],
        });
        const h = headersOf(mime);
        expect(h.get('in-reply-to')).toBe('<root@acme.example>');
        expect(h.get('references')).toBe('<first@acme.example> <root@acme.example>');
    });

    it('is deterministic for the same input (the boundary comes from the Message-ID)', () => {
        expect(buildMime(base)).toBe(buildMime(base));
    });
});

describe('FR-CRMS-2 message ids and reply subjects', () => {
    it('makes a Message-ID on our domain-agnostic form, unique each time', () => {
        const a = newMessageId();
        const b = newMessageId();
        expect(a).toMatch(/^[0-9a-f-]{36}@bylinecrm$/);
        expect(a).not.toBe(b);
    });

    it('prefixes Re: once', () => {
        expect(replySubject('Pricing')).toBe('Re: Pricing');
        expect(replySubject('Re: Pricing')).toBe('Re: Pricing');
        expect(replySubject('RE: Pricing')).toBe('RE: Pricing');
        expect(replySubject('')).toBe('Re:');
    });
});

describe('FR-CRMS-7 one-click unsubscribe headers', () => {
    const url = 'https://crm.example/api/unsubscribe/Zm9vYmFyYmF6cXV4cXV1eGNvcmdlZ3JhdWx0Z2FycGx5';

    it('writes List-Unsubscribe and List-Unsubscribe-Post (RFC 8058) on an outreach message', () => {
        const h = headersOf(buildMime({ ...base, listUnsubscribe: { url } }));
        expect(h.get('list-unsubscribe')).toBe(`<${url}>`);
        expect(h.get('list-unsubscribe-post')).toBe('List-Unsubscribe=One-Click');
    });

    it('writes neither on personal mail', () => {
        const h = headersOf(buildMime(base));
        expect(h.has('list-unsubscribe')).toBe(false);
        expect(h.has('list-unsubscribe-post')).toBe(false);
    });

    it('cannot be used to start a header of its own', () => {
        const mime = buildMime({ ...base, listUnsubscribe: { url: `${url}\r\nBcc: someone@evil.example` } });
        expect(headersOf(mime).has('bcc')).toBe(false);
    });
});

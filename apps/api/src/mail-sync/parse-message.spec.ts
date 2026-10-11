import { describe, expect, it } from 'vitest';
import type { GmailPart, GmailRawMessage } from './gmail.port';
import { dsnPayload } from '../../test/support/dsn';
import { parseGmailMessage } from './parse-message';

const b64 = (value: string | Buffer) => Buffer.from(value).toString('base64url');

function message(headers: Record<string, string>, payload: Partial<GmailPart> = {}): GmailRawMessage {
    return {
        id: 'm1',
        threadId: 't1',
        labelIds: ['INBOX'],
        snippet: 'It&#39;s &quot;here&quot;',
        internalDate: '1760000000000',
        payload: {
            mimeType: 'text/plain',
            headers: Object.entries(headers).map(([name, value]) => ({ name, value })),
            body: { data: b64('Plain body') },
            ...payload,
        },
    };
}

describe('parseGmailMessage', () => {
    it('reads ids, subject, participants (lower-cased, groups flattened, names decoded) and the snippet', () => {
        const parsed = parseGmailMessage(
            message({
                From: '"Reyes, Dana" <Dana@Acme.Example>',
                To: 'kate@pinion.example, Team: a@b.example, C@D.example;',
                Cc: '=?UTF-8?B?SsO2cmc=?= <jorg@x.example>',
                Subject: '=?UTF-8?B?UmU6IFByaWNpbmcg4pyT?=',
                'Message-ID': '<abc@mail.acme.example>',
                'In-Reply-To': '<root@pinion.example>',
                References: '<root@pinion.example> <mid@acme.example>',
                Date: 'Thu, 09 Oct 2026 09:30:00 +0000',
            }),
        );
        expect(parsed).toMatchObject({
            providerMessageId: 'm1',
            providerThreadId: 't1',
            rfc822MessageId: 'abc@mail.acme.example',
            inReplyTo: 'root@pinion.example',
            references: ['root@pinion.example', 'mid@acme.example'],
            subject: 'Re: Pricing ✓',
            from: 'dana@acme.example',
            snippet: 'It\'s "here"',
            bodyText: 'Plain body',
            bodyHtml: null,
            hasAttachments: false,
        });
        expect(parsed.sentAt.toISOString()).toBe('2026-10-09T09:30:00.000Z');
        expect(parsed.participants).toEqual([
            { role: 'from', address: 'dana@acme.example', displayName: 'Reyes, Dana' },
            { role: 'to', address: 'kate@pinion.example', displayName: '' },
            { role: 'to', address: 'a@b.example', displayName: '' },
            { role: 'to', address: 'c@d.example', displayName: '' },
            { role: 'cc', address: 'jorg@x.example', displayName: 'Jörg' },
        ]);
    });

    it('finds text and HTML inside nested multiparts, sanitises the HTML, and notes attachments', () => {
        const parsed = parseGmailMessage(
            message(
                { From: 'a@b.example' },
                {
                    mimeType: 'multipart/mixed',
                    body: { size: 0 },
                    parts: [
                        {
                            mimeType: 'multipart/alternative',
                            parts: [
                                { mimeType: 'text/plain', body: { data: b64('Hello text') } },
                                {
                                    mimeType: 'text/html',
                                    body: { data: b64('<p onclick="x">Hello <script>bad()</script><b>html</b></p>') },
                                },
                            ],
                        },
                        { mimeType: 'application/pdf', filename: 'deck.pdf', body: { attachmentId: 'att1', size: 9 } },
                    ],
                },
            ),
        );
        expect(parsed.bodyText).toBe('Hello text');
        expect(parsed.bodyHtml).toBe('<p>Hello <b>html</b></p>');
        expect(parsed.hasAttachments).toBe(true);
    });

    it('derives the text from HTML when there is no text part, and honours the charset', () => {
        const parsed = parseGmailMessage(
            message(
                { From: 'a@b.example' },
                {
                    mimeType: 'text/html',
                    headers: [{ name: 'Content-Type', value: 'text/html; charset="iso-8859-1"' }],
                    body: {
                        data: b64(Buffer.from([0x3c, 0x70, 0x3e, 0x63, 0x61, 0x66, 0xe9, 0x3c, 0x2f, 0x70, 0x3e])),
                    },
                },
            ),
        );
        expect(parsed.bodyHtml).toBe('<p>café</p>');
        expect(parsed.bodyText).toBe('café');
    });

    it('falls back to Gmail’s received time when the Date header does not parse', () => {
        const parsed = parseGmailMessage(message({ From: 'a@b.example', Date: 'not a date' }));
        expect(parsed.sentAt.getTime()).toBe(1760000000000);
    });

    it('has no sender when the message names none', () => {
        const parsed = parseGmailMessage(message({ To: 'x@y.example' }));
        expect(parsed.from).toBe('');
    });

    it('FR-CRMS-2 reads the CRM’s own X-BylineCRM-Id (any case), and ignores a value that is not a send id', () => {
        const id = '0190A1B2-C3D4-7E5F-8A6B-1C2D3E4F5A6B';
        expect(parseGmailMessage(message({ From: 'a@b.example', 'x-bylinecrm-id': ` ${id} ` })).crmId).toBe(
            id.toLowerCase(),
        );
        expect(parseGmailMessage(message({ From: 'a@b.example', 'X-BylineCRM-Id': 'not-an-id' })).crmId).toBeNull();
        expect(parseGmailMessage(message({ From: 'a@b.example' })).crmId).toBeNull();
    });
});

describe('FR-CRMS-6 bounce reports (P3-2)', () => {
    const crmId = '0b6f2f0e-6d1c-4c43-9a7f-0f3a4f1f2a11';
    const report = (fixture: Parameters<typeof dsnPayload>[0]): GmailRawMessage => ({
        id: 'b1',
        threadId: 't9',
        labelIds: ['INBOX'],
        snippet: 'Address not found',
        internalDate: '1760000000000',
        payload: dsnPayload(fixture).payload,
    });

    it('reads a permanent bounce: the failed address, its 5.x.x status and the send it answers', () => {
        const parsed = parseGmailMessage(
            report({ recipient: 'Gone@Acme.example', status: '5.1.1', crmId, to: 'pool@out.example' }),
        );
        expect(parsed.bounce).toEqual({
            recipients: [{ address: 'gone@acme.example', permanent: true, status: '5.1.1' }],
            crmId,
        });
    });

    it('reads a transient 4.x.x bounce as not permanent', () => {
        const parsed = parseGmailMessage(
            report({ recipient: 'busy@acme.example', status: '4.2.2', to: 'p@o.example' }),
        );
        expect(parsed.bounce?.recipients).toEqual([
            { address: 'busy@acme.example', permanent: false, status: '4.2.2' },
        ]);
        expect(parsed.bounce?.crmId).toBeNull();
    });

    it('reads the failed address from the delivery-status part when there is no X-Failed-Recipients header', () => {
        const parsed = parseGmailMessage(
            report({ recipient: 'x@acme.example', status: '5.7.1', failedRecipientsHeader: false, to: 'p@o.example' }),
        );
        expect(parsed.bounce?.recipients).toEqual([{ address: 'x@acme.example', permanent: true, status: '5.7.1' }]);
    });

    it('is null on an ordinary message, even one that mentions a delivery failure', () => {
        expect(
            parseGmailMessage(message({ From: 'a@b.example', Subject: 'Delivery Status Notification (Failure)' }))
                .bounce,
        ).toBeNull();
    });
});

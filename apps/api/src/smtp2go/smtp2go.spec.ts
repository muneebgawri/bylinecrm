import { describe, expect, it } from 'vitest';
import { buildMime } from '../mail-send/mime';
import { gmailShapeOf } from '../mail-send/mime-read';
import { parseGmailMessage } from '../mail-sync/parse-message';
import { evaluateDomain } from '../sending-pool/domain-checks';
import { parseSmtp2GoEvent, rejectedRecipient } from './smtp2go-event';
import { Smtp2GoHttp, type FetchLike } from './smtp2go.http';
import { Smtp2GoError } from './smtp2go.port';

const CRM_ID = '0b9a4a7e-2f4c-4c55-9a52-3c1f6c2a1d10';

describe('TRANS-1 SMTP2Go webhook events', () => {
    const bounce = {
        event: 'bounce',
        email_id: '1pjXOz-9EGeSN-09',
        'message-id': '<abc@bylinecrm>',
        rcpt: 'Gone@Acme.example',
        time: '2026-10-20T10:00:00Z',
        bounce: 'hard',
        message: '550 5.1.1 <gone@acme.example>: user unknown',
        'X-BylineCRM-Id': CRM_ID,
    };

    it('reads a hard bounce: the send, the address, permanence and the status code', () => {
        const event = parseSmtp2GoEvent(bounce);
        expect(event).toMatchObject({
            kind: 'bounce',
            emailId: '1pjXOz-9EGeSN-09',
            messageId: 'abc@bylinecrm',
            crmId: CRM_ID,
            address: 'gone@acme.example',
            permanent: true,
            status: '5.1.1',
            at: new Date('2026-10-20T10:00:00Z'),
        });
    });

    it('keys an event by what it is, so a redelivery has the same key and another event does not', () => {
        const a = parseSmtp2GoEvent(bounce);
        const b = parseSmtp2GoEvent({ ...bounce });
        const soft = parseSmtp2GoEvent({ ...bounce, bounce: 'soft', time: '2026-10-20T10:05:00Z' });
        expect(a.kind === 'bounce' && b.kind === 'bounce' && a.key === b.key).toBe(true);
        expect(soft).toMatchObject({ kind: 'bounce', permanent: false });
        expect(soft.kind === 'bounce' && a.kind === 'bounce' && soft.key !== a.key).toBe(true);
    });

    it('reads spam, open and click; anything else is acknowledged and not read', () => {
        expect(parseSmtp2GoEvent({ ...bounce, event: 'spam' })).toMatchObject({ kind: 'spam' });
        expect(parseSmtp2GoEvent({ ...bounce, event: 'open', 'user-agent': 'Mozilla/5.0' })).toMatchObject({
            kind: 'open',
            userAgent: 'Mozilla/5.0',
        });
        expect(parseSmtp2GoEvent({ ...bounce, event: 'click', url: 'https://acme.example/x' })).toMatchObject({
            kind: 'click',
            url: 'https://acme.example/x',
        });
        expect(parseSmtp2GoEvent({ event: 'processed' })).toEqual({ kind: 'other', event: 'processed' });
        expect(parseSmtp2GoEvent({ event: 'resubscribe' })).toEqual({ kind: 'other', event: 'resubscribe' });
        expect(parseSmtp2GoEvent({ event: 'toString' })).toEqual({ kind: 'other', event: 'tostring' });
        expect(parseSmtp2GoEvent('nonsense')).toEqual({ kind: 'other', event: '' });
    });

    it('reads reject, unsubscribe and delivered, by the webhook’s names and the activity API’s past tense', () => {
        const reject = parseSmtp2GoEvent({
            ...bounce,
            event: 'reject',
            message: 'Recipient is on the suppression list',
        });
        expect(reject).toMatchObject({ kind: 'reject', reason: 'Recipient is on the suppression list', crmId: CRM_ID });
        expect(parseSmtp2GoEvent({ ...bounce, event: 'Rejected' })).toMatchObject({ kind: 'reject' });
        expect(parseSmtp2GoEvent({ ...bounce, event: 'unsubscribe' })).toMatchObject({
            kind: 'unsubscribe',
            address: 'gone@acme.example',
        });
        expect(parseSmtp2GoEvent({ ...bounce, event: 'unsubscribed' })).toMatchObject({ kind: 'unsubscribe' });
        expect(parseSmtp2GoEvent({ ...bounce, event: 'delivered' })).toMatchObject({
            kind: 'delivered',
            at: new Date('2026-10-20T10:00:00Z'),
        });
    });

    it('keys a variant name as the event it is, so `rejected` redelivered as `reject` is the same event', () => {
        const a = parseSmtp2GoEvent({ ...bounce, event: 'reject' });
        const b = parseSmtp2GoEvent({ ...bounce, event: 'rejected' });
        const delivered = parseSmtp2GoEvent({ ...bounce, event: 'delivered' });
        expect(a.kind === 'reject' && b.kind === 'reject' && a.key === b.key).toBe(true);
        expect(a.kind === 'reject' && delivered.kind === 'delivered' && a.key !== delivered.key).toBe(true);
    });

    it('tells a reject for the recipient (SMTP2Go’s suppressions) from one on our side', () => {
        expect(rejectedRecipient('Recipient is on the suppression list (unsubscribed)')).toEqual({
            recipient: true,
            suppression: 'unsubscribe',
        });
        expect(rejectedRecipient('Suppressed: spam complaint')).toEqual({ recipient: true, suppression: 'complaint' });
        expect(rejectedRecipient('Address suppressed after hard bounce')).toEqual({
            recipient: true,
            suppression: 'hard_bounce',
        });
        expect(rejectedRecipient('Recipient address is on the suppression list')).toEqual({
            recipient: true,
            suppression: null,
        });
        expect(rejectedRecipient('Sender address is not verified')).toEqual({ recipient: false });
        expect(rejectedRecipient('API key is sandboxed')).toEqual({ recipient: false });
        expect(rejectedRecipient(null)).toEqual({ recipient: false });
    });

    it('ignores a send id that is not one of ours, and reads epoch-second times', () => {
        expect(parseSmtp2GoEvent({ ...bounce, 'X-BylineCRM-Id': 'nope', time: '1760954400' })).toMatchObject({
            crmId: null,
            at: new Date(1760954400 * 1000),
        });
    });
});

describe('TRANS-1 SMTP2Go HTTP adapter', () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const answer =
        (status: number, body: unknown): FetchLike =>
        async (url, init) => {
            calls.push({ url, init });
            return new Response(JSON.stringify(body), { status });
        };

    it('posts the MIME as built, base64, with the key in its header, and returns SMTP2Go’s id', async () => {
        const http = new Smtp2GoHttp(answer(200, { data: { succeeded: 1, failed: 0, email_id: 'e-1' } }));
        await expect(http.sendMime('api-KEY0123456789abcdef', 'Subject: hi\r\n\r\nhello')).resolves.toEqual({
            emailId: 'e-1',
        });
        const call = calls.at(-1)!;
        expect(call.url).toBe('https://api.smtp2go.com/v3/email/mime');
        expect((call.init.headers as Record<string, string>)['X-Smtp2go-Api-Key']).toBe('api-KEY0123456789abcdef');
        const sent = JSON.parse(call.init.body as string) as { mime_email: string };
        expect(Buffer.from(sent.mime_email, 'base64').toString('utf8')).toBe('Subject: hi\r\n\r\nhello');
    });

    it('says whether a failure may be retried, was refused, or may have gone', async () => {
        const outcome = async (fetchFn: FetchLike) =>
            new Smtp2GoHttp(fetchFn).sendMime('k', 'm').catch((e: unknown) => (e as Smtp2GoError).outcome);
        expect(await outcome(answer(429, {}))).toBe('retry');
        expect(await outcome(answer(503, {}))).toBe('retry');
        expect(await outcome(answer(401, { data: { error_code: 'E_ApiResponseCodes.API_KEY_INVALID' } }))).toBe(
            'refused',
        );
        expect(await outcome(answer(200, { data: { succeeded: 0, failed: 1, error_code: 'x' } }))).toBe('refused');
        expect(await outcome(answer(500, {}))).toBe('unconfirmed');
        expect(
            await outcome(async () => {
                throw Object.assign(new Error('t'), { name: 'TimeoutError' });
            }),
        ).toBe('unconfirmed');
        expect(
            await outcome(async () => {
                throw new TypeError('fetch failed');
            }),
        ).toBe('retry');
    });

    it('keeps SMTP2Go’s own reason for a refusal, so the send says why', async () => {
        const refusal = async (body: unknown) =>
            new Smtp2GoHttp(answer(403, body)).sendMime('k', 'm').catch((e: unknown) => (e as Smtp2GoError).refusal);
        expect(
            await refusal({ data: { error_code: 'E_ApiResponseCodes.API_EXCEPTION', error: 'Sender not allowed' } }),
        ).toBe('SMTP2Go refused the message (403): Sender not allowed');
        expect(await refusal({ data: { error_code: 'x', failures: ['Recipient blocked'] } })).toBe(
            'SMTP2Go refused the message (403): Recipient blocked',
        );
        expect(await refusal({ data: { error_code: 'x' } })).toBe('SMTP2Go refused the message (403)');
    });
});

describe('TRANS-1 a send through SMTP2Go is stored like a Gmail send', () => {
    it('reads back the message the builder wrote: ids, recipients, subject and body', () => {
        const mime = buildMime({
            from: { address: 'pool@out.example', name: 'Pool' },
            to: [{ address: 'ann@acme.example', name: 'Ann' }],
            subject: 'Quick question',
            text: 'Hello Ann',
            html: '<p>Hello Ann</p>',
            messageId: 'abc@bylinecrm',
            crmId: CRM_ID,
            inReplyTo: null,
            references: [],
            date: new Date('2026-10-20T10:00:00Z'),
        });
        const parsed = parseGmailMessage(
            gmailShapeOf(mime, { id: 'smtp2go:e-1', threadId: 'smtp2go:e-1', sentAt: new Date() }),
        );
        expect(parsed).toMatchObject({
            providerMessageId: 'smtp2go:e-1',
            rfc822MessageId: 'abc@bylinecrm',
            crmId: CRM_ID,
            subject: 'Quick question',
            from: 'pool@out.example',
            bodyText: 'Hello Ann',
            labelIds: ['SENT'],
        });
        expect(parsed.participants.map((p) => [p.role, p.address])).toEqual([
            ['from', 'pool@out.example'],
            ['to', 'ann@acme.example'],
        ]);
    });
});

describe('TRANS-1 / FR-CRMS-13 a sending domain for SMTP2Go', () => {
    it('passes SPF that names SMTP2Go instead of Google', () => {
        const txt = (name: string) =>
            ({
                'out.example': ['v=spf1 include:spf.smtp2go.com ~all'],
                's123._domainkey.out.example': ['v=DKIM1; k=rsa; p=MIGf'],
                '_dmarc.out.example': ['v=DMARC1; p=quarantine'],
            })[name] ?? [];
        const check = evaluateDomain('out.example', ['s123'], txt);
        expect(check.spf).toMatchObject({ outcome: 'pass', message: expect.stringContaining('SMTP2Go') });
        expect(check.dkim.outcome).toBe('pass');
    });
});

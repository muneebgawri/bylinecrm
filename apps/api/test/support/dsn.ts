import type { GmailHeader, GmailPart } from '../../src/mail-sync/gmail.port';

const b64 = (value: string) => Buffer.from(value).toString('base64url');

/** What a bounce report says, for the fixtures below. */
export interface DsnFixture {
    /** The address that failed. */
    recipient: string;
    /** The enhanced status code: `5.1.1` permanent, `4.2.2` transient. */
    status: string;
    /** The original message's `X-BylineCRM-Id`, returned in the report's copy of its headers. */
    crmId?: string;
    /** Whether Gmail's `X-Failed-Recipients` header is present (it is on Gmail's own reports). */
    failedRecipientsHeader?: boolean;
    /** The mailbox the original went from (the report is addressed to it). */
    to: string;
}

/**
 * A delivery status notification the way Gmail returns one to the sending mailbox (RFC 3464):
 * `multipart/report; report-type=delivery-status` with a human-readable part, the machine-readable
 * `message/delivery-status` part and the original message's headers (`text/rfc822-headers`).
 */
export function dsnPayload(fixture: DsnFixture, date = new Date()): { headers: GmailHeader[]; payload: GmailPart } {
    const headers: GmailHeader[] = [
        { name: 'From', value: 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>' },
        { name: 'To', value: fixture.to },
        { name: 'Subject', value: 'Delivery Status Notification (Failure)' },
        { name: 'Date', value: date.toUTCString() },
        { name: 'Auto-Submitted', value: 'auto-replied' },
        ...(fixture.failedRecipientsHeader === false
            ? []
            : [{ name: 'X-Failed-Recipients', value: fixture.recipient }]),
        {
            name: 'Content-Type',
            value: 'multipart/report; boundary="b1"; report-type=delivery-status',
        },
    ];
    const permanent = fixture.status.startsWith('5.');
    const status = [
        'Reporting-MTA: dns; googlemail.com',
        '',
        `Final-Recipient: rfc822; ${fixture.recipient}`,
        `Action: ${permanent ? 'failed' : 'delayed'}`,
        `Status: ${fixture.status}`,
        `Diagnostic-Code: smtp; ${permanent ? '550' : '421'} ${fixture.status} The email account that you tried to reach does not exist.`,
        '',
    ].join('\r\n');
    const original = [
        `From: ${fixture.to}`,
        `To: ${fixture.recipient}`,
        'Subject: Quick question',
        ...(fixture.crmId ? [`X-BylineCRM-Id: ${fixture.crmId}`] : []),
        '',
    ].join('\r\n');
    return {
        headers,
        payload: {
            mimeType: 'multipart/report',
            headers,
            parts: [
                {
                    mimeType: 'text/plain',
                    body: {
                        data: b64(`Address not found\r\n\r\nYour message wasn't delivered to ${fixture.recipient}.`),
                    },
                },
                { mimeType: 'message/delivery-status', body: { data: b64(status) } },
                { mimeType: 'text/rfc822-headers', body: { data: b64(original) } },
            ],
        },
    };
}

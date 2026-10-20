import { createHash } from 'node:crypto';
import { MAIL_CRM_ID_HEADER } from '../mail-send/mail-send.constants';

/**
 * One SMTP2Go webhook delivery (TRANS-1), as the CRM reads it. SMTP2Go posts one event per request, JSON or
 * form-encoded, with `event` (`processed`, `delivered`, `open`, `click`, `bounce`, `spam`, `unsubscribe`, …),
 * `email_id`, `message-id` (ours, since we send the MIME as built), `rcpt`, `time`, and for a bounce `bounce`
 * (`hard` / `soft`) and `message`; a custom header the webhook is set to include (our `X-BylineCRM-Id`) arrives
 * as a field of its own name. Pure: no clock but the fallback, no I/O.
 */
export type Smtp2GoEvent =
    | {
          kind: 'bounce' | 'spam' | 'open' | 'click';
          /** Stable across redeliveries of the same event: what makes a replay change nothing. */
          key: string;
          emailId: string | null;
          /** Our Message-ID, without angle brackets. */
          messageId: string | null;
          /** Our send's id, when the webhook includes the `X-BylineCRM-Id` header. */
          crmId: string | null;
          /** The recipient the event is about, lower case. */
          address: string | null;
          at: Date;
          /** A bounce: `hard` is permanent. */
          permanent: boolean;
          /** A bounce: the enhanced status code in SMTP2Go's message, when it gives one. */
          status: string | null;
          /** A click: the link followed. */
          url: string | null;
          userAgent: string | undefined;
      }
    | { kind: 'other'; event: string };

const READ = new Set(['bounce', 'spam', 'open', 'click']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseSmtp2GoEvent(body: unknown, now = new Date()): Smtp2GoEvent {
    const fields = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
    const text = (name: string): string | null => {
        const value = fields[name] ?? fields[name.toLowerCase()];
        return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
    };
    const event = (text('event') ?? '').toLowerCase();
    if (!READ.has(event)) return { kind: 'other', event: event.slice(0, 40) };

    const emailId = text('email_id');
    const messageId = text('message-id')?.replace(/^<|>$/g, '') ?? null;
    const crm = text(MAIL_CRM_ID_HEADER);
    const address = (text('rcpt') ?? firstOf(fields['recipients']))?.toLowerCase() ?? null;
    const rawTime = text('time');
    const url = text('url') ?? text('link');
    const key = createHash('sha256')
        .update([emailId, messageId, event, address, rawTime, url].map((v) => v ?? '').join('\u0000'))
        .digest('hex');
    return {
        kind: event as 'bounce' | 'spam' | 'open' | 'click',
        key,
        emailId,
        messageId,
        crmId: crm && UUID.test(crm) ? crm.toLowerCase() : null,
        address,
        at: timeOf(rawTime) ?? now,
        permanent: (text('bounce') ?? '').toLowerCase() === 'hard',
        status: /\b([45]\.\d{1,3}\.\d{1,3})\b/.exec(text('message') ?? '')?.[1] ?? null,
        url,
        userAgent: text('user-agent') ?? undefined,
    };
}

function firstOf(value: unknown): string | null {
    if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
    return typeof value === 'string' ? (value.split(',')[0]?.trim() ?? null) : null;
}

/** SMTP2Go's `time`: an ISO-8601 timestamp, or epoch seconds. */
function timeOf(raw: string | null): Date | null {
    if (!raw) return null;
    const at = /^\d+(\.\d+)?$/.test(raw) ? new Date(Number(raw) * 1000) : new Date(raw);
    return Number.isNaN(at.getTime()) ? null : at;
}

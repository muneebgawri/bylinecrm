import type { INestApplication } from '@nestjs/common';
import type request from 'supertest';
import { MailOutboxRelay } from '../../src/transactional-mail/mail-outbox-relay';
import { memoryOutbox, type SentMail } from '../../src/transactional-mail/memory.transport';

/**
 * Transactional mail in the cross-tenant suite (#93). The suite runs no mail relay
 * (`TRANSACTIONAL_MAIL_RELAY=0`): a spec sends what was recorded itself, through the relay's own
 * `drain`, into the in-process memory transport. Nothing is sent anywhere.
 */

/** Sends every recorded mail that is due (at `now()`, default the real clock), the way the relay does. */
export function deliverMail(app: INestApplication, now?: () => Date): Promise<void> {
    return app.get(MailOutboxRelay).drain(now);
}

/** Mail delivered to `to` (lower-cased) since the suite started, oldest first. */
export function mailTo(to: string, kind?: SentMail['kind']): SentMail[] {
    const address = to.toLowerCase();
    return memoryOutbox.messages().filter((m) => m.to === address && (kind === undefined || m.kind === kind));
}

/** The newest mail of `kind` to `to`; fails the test with a clear message when there is none. */
export function lastMailTo(to: string, kind: SentMail['kind']): SentMail {
    const mail = mailTo(to, kind).at(-1);
    if (!mail) throw new Error(`no ${kind} mail was delivered to ${to}`);
    return mail;
}

/** The single-use token in a mail's link (`…?token=…`), read from the text part. */
export function tokenIn(mail: SentMail): string {
    const match = /[?&]token=([A-Za-z0-9_-]+)/.exec(mail.text);
    if (!match?.[1]) throw new Error(`no token link in the ${mail.kind} mail to ${mail.to}`);
    return match[1];
}

/**
 * Proves `email` reads its mailbox, the way a person does: send the recorded mail, take the
 * verification link, post it. Every spec that signs a tenant up calls this before using tenant
 * routes, which answer `403 email.unverified` until it is done.
 */
export async function verifyAddress(app: INestApplication, http: () => request.Agent, email: string): Promise<void> {
    await deliverMail(app);
    const token = tokenIn(lastMailTo(email, 'email_verification'));
    await http().post('/api/auth/email/verify').send({ token }).expect(204);
}

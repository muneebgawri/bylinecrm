import type { INestApplication } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import type request from 'supertest';
import { memoryOutbox, type SentMail } from '../../src/transactional-mail/memory.transport';
import { TRANSACTIONAL_MAIL_QUEUE } from '../../src/transactional-mail/transactional-mail.constants';
import { TransactionalMailer, type TransactionalMailJob } from '../../src/transactional-mail/transactional-mailer';

/**
 * Transactional mail in the cross-tenant suite (#93). The suite runs no mail worker
 * (`TRANSACTIONAL_MAIL_WORKER=0`); a spec delivers what is queued itself, through the same
 * `deliver` the worker calls, into the in-process memory transport. Nothing is sent anywhere.
 */

/** Delivers every queued transactional mail of this application, oldest first, and removes the jobs. */
export async function deliverQueuedMail(app: INestApplication): Promise<void> {
    const queue = app.get<Queue<TransactionalMailJob>>(getQueueToken(TRANSACTIONAL_MAIL_QUEUE));
    const mailer = app.get(TransactionalMailer);
    const jobs = await queue.getJobs(['waiting', 'delayed', 'prioritized']);
    jobs.sort((a, b) => a.timestamp - b.timestamp);
    for (const job of jobs) {
        await mailer.deliver(job.data);
        await job.remove();
    }
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
 * Proves `email` reads its mailbox, the way a person does: deliver the queued mail, take the
 * verification link, post it. Every spec that signs a tenant up calls this before using tenant
 * routes, which answer `403 email.unverified` until it is done.
 */
export async function verifyAddress(app: INestApplication, http: () => request.Agent, email: string): Promise<void> {
    await deliverQueuedMail(app);
    const token = tokenIn(lastMailTo(email, 'email_verification'));
    await http().post('/api/auth/email/verify').send({ token }).expect(204);
}

import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { ENV, type Env } from '../config/env';
import { SecretBox } from '../infra/secret-box';
import { assertNoOpenTransaction } from '../infra/transaction-scope';
import { TRANSACTIONAL_MAIL_QUEUE } from './transactional-mail.constants';
import { TRANSACTIONAL_MAIL_TRANSPORT, type OutgoingMail, type TransactionalMailTransport } from './transport.port';

/** A message to send; the sender is the deployment's (`MAIL_FROM`). */
export type TransactionalMail = Omit<OutgoingMail, 'from'>;

/**
 * A queued mail. The whole message — recipient, subject, both bodies, and so the link — is sealed
 * with `SecretBox`: a single-use link is a credential and never sits in Redis in clear.
 */
export interface TransactionalMailJob {
    sealed: string;
}

/**
 * The one way transactional mail leaves the application (#93). A service calls `enqueue` **after**
 * the transaction that made the mail necessary has committed; the worker calls `deliver`. The
 * mail's idempotency key is its job id, so a second enqueue of the same mail is dropped by the
 * queue, and the transport's idempotency key, so a retried delivery is not a second message.
 *
 * #98 (the transactional outbox) replaces the after-commit enqueue with a row written in the
 * transaction; `enqueue` is the one call site it changes.
 */
@Injectable()
export class TransactionalMailer {
    private readonly logger = new Logger(TransactionalMailer.name);

    constructor(
        @Inject(ENV) private readonly env: Env,
        @InjectQueue(TRANSACTIONAL_MAIL_QUEUE) private readonly queue: Queue<TransactionalMailJob>,
        private readonly box: SecretBox,
        @Inject(TRANSACTIONAL_MAIL_TRANSPORT) private readonly transport: TransactionalMailTransport,
    ) {}

    /**
     * Queues one message. Never fails its caller: the change that needed the mail has committed, and
     * every mail has a way back (ask for a new link, request a reset again, the link shown to the
     * inviter). A queue failure is logged with the mail's kind and key, never its content.
     */
    async enqueue(mail: TransactionalMail): Promise<void> {
        assertNoOpenTransaction('transactional mail enqueue');
        const message: OutgoingMail = { ...mail, from: this.env.MAIL_FROM };
        try {
            await this.queue.add(
                mail.kind,
                { sealed: this.box.seal(JSON.stringify(message)) },
                { jobId: mail.idempotencyKey },
            );
        } catch (error) {
            this.logger.error(
                `could not queue ${mail.kind} mail ${mail.idempotencyKey}: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }

    /** Sends one queued message through this process's transport. Throws for the queue to retry. */
    deliver(job: TransactionalMailJob): Promise<{ id: string }> {
        const mail = JSON.parse(this.box.open(job.sealed)) as OutgoingMail;
        return this.transport.send(mail);
    }
}

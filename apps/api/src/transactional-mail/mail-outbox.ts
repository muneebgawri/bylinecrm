import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { ENV, type Env } from '../config/env';
import type { WorkspaceClient } from '../infra/rls-prisma.service';
import { SecretBox } from '../infra/secret-box';
import { afterCommit, transactionOpen } from '../infra/transaction-scope';
import { MailOutboxRelay } from './mail-outbox-relay';
import type { OutgoingMail } from './transport.port';

/** A message to send; the sender is the deployment's (`MAIL_FROM`). */
export type TransactionalMail = Omit<OutgoingMail, 'from'>;

/** The transaction a mail is recorded in: a tenant one (`withWorkspace`) or the owner client's. */
export type MailTransaction = WorkspaceClient | Prisma.TransactionClient;

/**
 * The one way transactional mail leaves the application (#93). A service records the mail **inside**
 * the transaction that makes it necessary — the token issued, the invitation written — so the mail
 * exists exactly when the change committed: a rollback takes it with it, a crash after the commit
 * cannot lose it (P1-6's rule). `MailOutboxRelay` sends it after the commit.
 *
 * The whole message is sealed with `SecretBox`: a single-use link is a credential, and the row holds
 * it only until it is sent.
 */
@Injectable()
export class MailOutbox {
    constructor(
        @Inject(ENV) private readonly env: Env,
        private readonly box: SecretBox,
        private readonly relay: MailOutboxRelay,
    ) {}

    /**
     * Records `mail` in `tx`. A workspace's own mail (an invitation) names its workspace and is
     * recorded in that workspace's tenant transaction, where the relay is woken at the commit; an
     * account's mail is recorded in an owner transaction, whose caller calls `kick()` after it — and
     * the relay's scan finds it within `MAIL_OUTBOX_POLL_MS` either way. Recording the same mail
     * twice (its idempotency key) keeps one.
     */
    async record(tx: MailTransaction, mail: TransactionalMail, workspaceId: string | null = null): Promise<void> {
        if (transactionOpen()) afterCommit('MailOutbox.record', () => this.relay.kick());
        const message: OutgoingMail = { ...mail, from: this.env.MAIL_FROM };
        // createMany: the app role may insert but not read the table back (no RETURNING).
        await tx.mailOutbox.createMany({
            data: [
                {
                    id: randomUUID(),
                    workspaceId,
                    kind: mail.kind,
                    idempotencyKey: mail.idempotencyKey,
                    sealed: this.box.seal(JSON.stringify(message)),
                },
            ],
            skipDuplicates: true,
        });
    }

    /** Wakes the relay after an owner transaction that recorded mail has committed. */
    kick(): void {
        this.relay.kick();
    }
}

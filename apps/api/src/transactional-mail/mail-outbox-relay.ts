import { Inject, Injectable, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { ENV, type Env } from '../config/env';
import { PrismaService } from '../infra/prisma.service';
import { describe, RelayEngine, type ClaimedBase, type HandleResult, type SettleState } from '../infra/relay-engine';
import { SecretBox } from '../infra/secret-box';
import { WorkspaceContext } from '../infra/workspace-context';
import {
    MAIL_OUTBOX_BATCH,
    MAIL_OUTBOX_CONCURRENCY,
    MAIL_OUTBOX_LEASE_MS,
    MAIL_OUTBOX_MAX_ATTEMPTS,
    MAIL_OUTBOX_POLL_MS,
    MAIL_OUTBOX_RETENTION_DAYS,
    MAIL_OUTBOX_RETENTION_EVERY_MS,
    mailRetryDelayMs,
} from './transactional-mail.constants';
import {
    PermanentMailError,
    TRANSACTIONAL_MAIL_TRANSPORT,
    type OutgoingMail,
    type TransactionalMailTransport,
} from './transport.port';

/** A mail one scan claimed. */
interface ClaimedMail extends ClaimedBase {
    kind: string;
    idempotencyKey: string;
    sealed: string;
}

/** What a successful send writes besides its outcome: the provider's id for the message. */
interface SendExtra {
    providerMessageId: string;
}

/**
 * Sends recorded transactional mail (#93) on the shared relay engine (`RelayEngine`), the one the
 * domain-event relay runs on: claims with `FOR UPDATE SKIP LOCKED` and a lease, retries with a
 * doubling wait from 30 s, gives up past `MAIL_OUTBOX_MAX_ATTEMPTS`, wakes on a local commit and
 * polls every `MAIL_OUTBOX_POLL_MS`, keeps rows for `MAIL_OUTBOX_RETENTION_DAYS`.
 *
 * What is this relay's own: each claimed mail is opened (`SecretBox`) and sent through the transport
 * with no transaction open. A refusal no retry can fix (`PermanentMailError`) fails it at once. Once
 * a mail is sent or given up on, its sealed payload is wiped — the link is no longer stored. A
 * re-send after a lost answer or an expired lease carries the same idempotency key, which the
 * provider answers without sending twice. Logs name the mail's kind and key, never its recipient or
 * link. `TRANSACTIONAL_MAIL_RELAY=0` turns the wake-ups and timers off (the cross-tenant suite drains
 * it itself).
 */
@Injectable()
export class MailOutboxRelay implements OnApplicationBootstrap, OnModuleDestroy {
    private readonly engine: RelayEngine<ClaimedMail, SendExtra>;

    constructor(
        @Inject(ENV) env: Env,
        private readonly ownerPrisma: PrismaService,
        context: WorkspaceContext,
        private readonly box: SecretBox,
        @Inject(TRANSACTIONAL_MAIL_TRANSPORT) private readonly transport: TransactionalMailTransport,
    ) {
        this.engine = new RelayEngine<ClaimedMail, SendExtra>(
            {
                name: 'mail outbox',
                table: 'mail_outbox',
                doneColumn: 'sent_at',
                returning: 'kind, idempotency_key AS "idempotencyKey", sealed',
                enabled: env.TRANSACTIONAL_MAIL_RELAY,
                pollMs: MAIL_OUTBOX_POLL_MS,
                batch: MAIL_OUTBOX_BATCH,
                concurrency: MAIL_OUTBOX_CONCURRENCY,
                leaseMs: MAIL_OUTBOX_LEASE_MS,
                maxAttempts: MAIL_OUTBOX_MAX_ATTEMPTS,
                retryDelayMs: mailRetryDelayMs,
                retention: {
                    doneDays: MAIL_OUTBOX_RETENTION_DAYS.sent,
                    failedDays: MAIL_OUTBOX_RETENTION_DAYS.failed,
                    everyMs: MAIL_OUTBOX_RETENTION_EVERY_MS,
                },
                label: (mail) => `${mail.kind} mail ${mail.idempotencyKey}`,
                handle: (mail) => this.send(mail),
                settle: (id, state, extra) => this.settle(id, state, extra),
            },
            ownerPrisma,
            context,
            MailOutboxRelay.name,
        );
    }

    onApplicationBootstrap(): void {
        this.engine.start();
    }

    onModuleDestroy(): Promise<void> {
        return this.engine.stop();
    }

    /** Wakes the relay; never throws and never waits — it is called from a commit hook. */
    kick(): void {
        this.engine.kick();
    }

    /** Sends until nothing is due at `now()`, waiting for a pass in flight. For tests; works with the relay off. */
    drain(now?: () => Date): Promise<void> {
        return this.engine.drain(now);
    }

    /** One scan: claims what is due at `now` and sends it. Returns how many mails it claimed. */
    runOnce(now?: Date): Promise<number> {
        return this.engine.runOnce(now);
    }

    /** Deletes sent mail past its retention, and failed mail past its. */
    async prune(now = Date.now()): Promise<{ sent: number; failed: number }> {
        const { done, failed } = await this.engine.prune(now);
        return { sent: done, failed };
    }

    private async send(mail: ClaimedMail): Promise<HandleResult<SendExtra>> {
        try {
            const message = JSON.parse(this.box.open(mail.sealed)) as OutgoingMail;
            const { id } = await this.transport.send(message);
            return { ok: true, extra: { providerMessageId: id } };
        } catch (error) {
            return { ok: false, error: describe(error), permanent: error instanceof PermanentMailError };
        }
    }

    /** Writes a send's outcome, wipes the payload once it is final, and releases the claim. */
    private async settle(id: string, state: SettleState, extra: SendExtra | undefined): Promise<void> {
        const outcome =
            state.outcome === 'completed'
                ? { sentAt: state.at, lastError: null, sealed: '' }
                : state.outcome === 'failed'
                  ? { failedAt: state.at, lastError: state.lastError, sealed: '' }
                  : { nextAttemptAt: state.nextAttemptAt, lastError: state.lastError };
        await this.ownerPrisma.mailOutbox.update({
            where: { id },
            data: { ...outcome, ...(extra ?? {}), leaseUntil: null },
        });
    }
}

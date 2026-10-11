import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ENV, type Env } from '../config/env';
import { PrismaService } from '../infra/prisma.service';
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

const DAY_MS = 24 * 60 * 60 * 1000;

/** A mail one scan claimed. */
interface ClaimedMail {
    id: string;
    kind: string;
    idempotencyKey: string;
    sealed: string;
    /** Including the attempt this claim starts. */
    attempts: number;
}

/** How one send went, for the relay's bookkeeping and the tests. */
export type MailOutcome = 'sent' | 'retrying' | 'failed';

/**
 * Sends recorded transactional mail (#93), at least once — and, through the provider's idempotency
 * key, once. The same shape as P1-6's `OutboxRelay`: a scan claims open mail (not sent, not failed,
 * due, not held by a live claim) with `FOR UPDATE SKIP LOCKED`, sets a lease and counts the attempt in
 * one statement; each mail is then sent with **no transaction open**, and the outcome written:
 *
 * - sent: `sent_at`, the provider's id, and the sealed payload wiped — the link is no longer stored;
 * - a refusal no retry can fix (`PermanentMailError`): `failed_at`, wiped, logged;
 * - a transient failure: retried after a doubling wait, until `MAIL_OUTBOX_MAX_ATTEMPTS`, then failed.
 *
 * A relay that dies mid-send leaves its lease to expire and the next scan sends again with the same
 * idempotency key, which the provider answers without sending twice. Logs name the mail's kind and
 * key, never its recipient or link. A commit wakes it (`kick`); a timer scans every
 * `MAIL_OUTBOX_POLL_MS`; `TRANSACTIONAL_MAIL_RELAY=0` turns both off (the cross-tenant suite drains it
 * itself).
 */
@Injectable()
export class MailOutboxRelay implements OnApplicationBootstrap, OnModuleDestroy {
    private readonly logger = new Logger(MailOutboxRelay.name);
    private running: Promise<void> | null = null;
    private kicked = false;
    private timers: NodeJS.Timeout[] = [];
    private stopped = false;

    constructor(
        @Inject(ENV) private readonly env: Env,
        private readonly ownerPrisma: PrismaService,
        private readonly context: WorkspaceContext,
        private readonly box: SecretBox,
        @Inject(TRANSACTIONAL_MAIL_TRANSPORT) private readonly transport: TransactionalMailTransport,
    ) {}

    onApplicationBootstrap(): void {
        if (!this.env.TRANSACTIONAL_MAIL_RELAY) return;
        this.timers.push(
            setInterval(() => this.kick(), MAIL_OUTBOX_POLL_MS).unref(),
            setInterval(() => void this.pruneLogged(), MAIL_OUTBOX_RETENTION_EVERY_MS).unref(),
        );
        // Once now: mail recorded while no relay ran goes out at start, not on the first tick.
        this.kick();
    }

    async onModuleDestroy(): Promise<void> {
        this.stopped = true;
        for (const timer of this.timers) clearInterval(timer);
        this.timers = [];
        await this.running;
    }

    /** Wakes the relay. Never throws and never waits: it is called from a commit hook. */
    kick(): void {
        if (!this.env.TRANSACTIONAL_MAIL_RELAY || this.stopped) return;
        if (this.running) {
            this.kicked = true;
            return;
        }
        this.running = this.context
            .detached(() => this.loop())
            .finally(() => {
                this.running = null;
            });
    }

    /** Sends until nothing is due at `now()`, waiting for a pass in flight. For tests; works with the relay off. */
    async drain(now?: () => Date): Promise<void> {
        for (;;) {
            await this.running;
            const claimed = await this.context.detached(() => this.runOnce(now?.()));
            if (claimed === 0 && !this.running) return;
        }
    }

    /** One scan: claims what is due at `now` and sends it. Returns how many mails it claimed. */
    async runOnce(now: Date = new Date()): Promise<number> {
        const claimed = await this.claim(now);
        for (let i = 0; i < claimed.length; i += MAIL_OUTBOX_CONCURRENCY) {
            await Promise.all(claimed.slice(i, i + MAIL_OUTBOX_CONCURRENCY).map((mail) => this.send(mail, now)));
        }
        return claimed.length;
    }

    /** Deletes sent mail past its retention, and failed mail past its. */
    async prune(now = Date.now()): Promise<{ sent: number; failed: number }> {
        const sent = await this.ownerPrisma.mailOutbox.deleteMany({
            where: { sentAt: { lt: new Date(now - MAIL_OUTBOX_RETENTION_DAYS.sent * DAY_MS) } },
        });
        const failed = await this.ownerPrisma.mailOutbox.deleteMany({
            where: { failedAt: { lt: new Date(now - MAIL_OUTBOX_RETENTION_DAYS.failed * DAY_MS) } },
        });
        return { sent: sent.count, failed: failed.count };
    }

    private async loop(): Promise<void> {
        do {
            this.kicked = false;
            try {
                while (!this.stopped && (await this.runOnce()) > 0) {
                    // A full batch may mean more is due: scan again at once.
                }
            } catch (error) {
                this.logger.error(`mail outbox scan failed: ${describe(error)}`);
                return;
            }
        } while (this.kicked && !this.stopped);
    }

    private claim(now: Date): Promise<ClaimedMail[]> {
        const leaseUntil = new Date(now.getTime() + MAIL_OUTBOX_LEASE_MS);
        return this.ownerPrisma.$queryRaw<ClaimedMail[]>(Prisma.sql`
            UPDATE mail_outbox
            SET lease_until = ${leaseUntil}, attempts = attempts + 1
            WHERE id IN (
                SELECT id FROM mail_outbox
                WHERE sent_at IS NULL AND failed_at IS NULL
                  AND (next_attempt_at IS NULL OR next_attempt_at <= ${now})
                  AND (lease_until IS NULL OR lease_until <= ${now})
                ORDER BY seq
                LIMIT ${MAIL_OUTBOX_BATCH}
                FOR UPDATE SKIP LOCKED
            )
            RETURNING id, kind, idempotency_key AS "idempotencyKey", sealed, attempts`);
    }

    private async send(mail: ClaimedMail, now: Date): Promise<MailOutcome> {
        try {
            const message = JSON.parse(this.box.open(mail.sealed)) as OutgoingMail;
            const { id } = await this.transport.send(message);
            await this.settle(mail.id, { sentAt: new Date(), providerMessageId: id, sealed: '', lastError: null });
            return 'sent';
        } catch (error) {
            const lastError = describe(error);
            if (error instanceof PermanentMailError || mail.attempts >= MAIL_OUTBOX_MAX_ATTEMPTS) {
                await this.settle(mail.id, { failedAt: new Date(), sealed: '', lastError });
                this.logger.error(`${mail.kind} mail ${mail.idempotencyKey} was not sent: ${lastError}`);
                return 'failed';
            }
            const nextAttemptAt = new Date(now.getTime() + mailRetryDelayMs(mail.attempts));
            await this.settle(mail.id, { nextAttemptAt, lastError });
            this.logger.warn(
                `${mail.kind} mail ${mail.idempotencyKey} attempt ${mail.attempts} failed, retrying at ${nextAttemptAt.toISOString()}: ${lastError}`,
            );
            return 'retrying';
        }
    }

    private async settle(id: string, data: Prisma.MailOutboxUpdateInput): Promise<void> {
        await this.ownerPrisma.mailOutbox.update({ where: { id }, data: { ...data, leaseUntil: null } });
    }

    private async pruneLogged(): Promise<void> {
        try {
            const pruned = await this.prune();
            if (pruned.sent + pruned.failed > 0) {
                this.logger.log(`pruned ${pruned.sent} sent and ${pruned.failed} failed mail outbox rows`);
            }
        } catch (error) {
            this.logger.error(`mail outbox retention failed: ${describe(error)}`);
        }
    }
}

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

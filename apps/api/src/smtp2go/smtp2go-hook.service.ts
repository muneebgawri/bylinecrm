import { timingSafeEqual } from 'node:crypto';
import { Injectable, NotFoundException } from '@nestjs/common';
import type { Smtp2GoHookResult } from '@bylinecrm/shared';
import { RateLimiter } from '../auth/rate-limiter.service';
import { hashToken } from '../auth/tokens';
import { DomainEvents } from '../events/domain-events.service';
import { ApiException, RateLimited } from '../infra/errors/api-errors';
import { PrismaService } from '../infra/prisma.service';
import { RlsPrismaService, type WorkspaceClient } from '../infra/rls-prisma.service';
import { SecretBox } from '../infra/secret-box';
import { recordProviderBounce } from '../sending-pool/bounces';
import { SuppressionService } from '../suppression/suppression.service';
import { TrackingService } from '../tracking/tracking.service';
import { parseSmtp2GoEvent, type Smtp2GoEvent } from './smtp2go-event';
import {
    SMTP2GO_HOOK_FAILURE_LIMIT,
    SMTP2GO_HOOK_FAILURE_WINDOW_S,
    SMTP2GO_PROVIDER_PREFIX,
    smtp2goHookRateKey,
} from './smtp2go.constants';

type Read = Extract<Smtp2GoEvent, { kind: 'bounce' | 'spam' | 'open' | 'click' }>;

/**
 * SMTP2Go's webhook for one pool mailbox (TRANS-1). The URL names the mailbox (read through the owner client, as
 * the other hooks read their token's workspace); the request must carry the mailbox's secret in SMTP2Go's
 * `Authorization` header — compared in constant time — or nothing is read. The event is matched to the send it
 * is about, from this mailbox only (SMTP2Go's `email_id`, our Message-ID, or our `X-BylineCRM-Id`), and then:
 * - `bounce` → `mail_bounces` + `email.bounced` (a hard one suppresses the address and counts towards the
 *   mailbox's bounce rate, by the same consumer as a Gmail bounce report);
 * - `spam` → the address suppressed as `complaint` from the provider (counts towards the complaint rate) and
 *   `email.complained`;
 * - `open` / `click` → `tracking_hits` + `email.opened` / `email.clicked`, unless our own short links track the
 *   send already.
 * Everything else SMTP2Go can send (`processed`, `delivered`, its own `unsubscribe`, …) is acknowledged and
 * ignored; replies are never SMTP2Go's — they arrive in the mailbox the message's Reply-To names, as before.
 * A redelivery changes nothing.
 */
@Injectable()
export class Smtp2GoHookService {
    constructor(
        // The hook has no workspace until its mailbox names one: the owner client reads that mapping only.
        private readonly ownerPrisma: PrismaService,
        private readonly rls: RlsPrismaService,
        private readonly secrets: SecretBox,
        private readonly events: DomainEvents,
        private readonly suppressions: SuppressionService,
        private readonly tracking: TrackingService,
        private readonly limiter: RateLimiter,
    ) {}

    async receive(
        mailboxId: string,
        authorization: string | undefined,
        body: unknown,
        clientIp: string,
    ): Promise<Smtp2GoHookResult> {
        const mailbox = await this.ownerPrisma.mailbox.findUnique({
            where: { id: mailboxId },
            select: { id: true, workspaceId: true, transport: true, hookSecretCiphertext: true },
        });
        if (!mailbox || mailbox.transport !== 'smtp2go' || !mailbox.hookSecretCiphertext) {
            await this.refused(clientIp);
            throw new NotFoundException('not found');
        }
        const ref = { id: mailbox.id, workspaceId: mailbox.workspaceId };
        if (!bearerMatches(authorization, this.secrets.open(mailbox.hookSecretCiphertext))) {
            await this.note(ref, 'bad_secret');
            await this.refused(clientIp);
            throw new ApiException(401, 'unauthorized', 'the delivery does not carry this mailbox’s hook secret');
        }
        const event = parseSmtp2GoEvent(body);
        const result = event.kind === 'other' ? 'ignored' : await this.apply(ref, event);
        await this.note(ref, result);
        return result;
    }

    private async apply(mailbox: { id: string; workspaceId: string }, event: Read): Promise<Smtp2GoHookResult> {
        if (event.kind === 'spam') return this.complaint(mailbox, event);
        return this.rls.withWorkspace(mailbox.workspaceId, async (tx) => {
            const send = await sendOf(tx, mailbox.id, event);
            if (!send) return 'unmatched';
            const address = event.address ?? send.toAddresses[0] ?? null;
            if (event.kind === 'bounce') {
                if (!address) return 'unmatched';
                const events = await recordProviderBounce(tx, mailbox, {
                    providerEventId: event.key,
                    address,
                    permanent: event.permanent,
                    status: event.status,
                    outboundId: send.id,
                    at: event.at,
                });
                if (events.length === 0) return 'duplicate';
                await this.events.recordAll(tx, events);
                return 'recorded';
            }
            return this.tracking.recordProviderHit(tx, mailbox.workspaceId, {
                outboundId: send.id,
                kind: event.kind === 'open' ? 'open' : 'click',
                url: event.url,
                userAgent: event.userAgent,
                at: event.at,
                providerEventId: `${SMTP2GO_PROVIDER_PREFIX}${event.key}`,
            });
        });
    }

    /**
     * A spam complaint: the address goes on the suppression list as `complaint` from the provider, naming the
     * send — which is what the pool's complaint rate counts (`SendingPoolConsumer`) — and `email.complained` is
     * announced once. A complaint already recorded for this send is a `duplicate`.
     */
    private async complaint(mailbox: { id: string; workspaceId: string }, event: Read): Promise<Smtp2GoHookResult> {
        const found = await this.rls.withWorkspace(mailbox.workspaceId, async (tx) => {
            const send = await sendOf(tx, mailbox.id, event);
            if (!send) return null;
            const address = event.address ?? send.toAddresses[0] ?? null;
            if (!address) return null;
            const already = await tx.suppression.count({
                where: { address, reason: 'complaint', outboundId: send.id },
            });
            return { send, address, already: already > 0 };
        });
        if (!found) return 'unmatched';
        if (found.already) return 'duplicate';
        await this.suppressions.suppress(mailbox.workspaceId, {
            address: found.address,
            reason: 'complaint',
            source: 'provider',
            personId: found.send.personId,
            outboundId: found.send.id,
        });
        await this.rls.withWorkspace(mailbox.workspaceId, (tx) =>
            this.events.record(tx, {
                type: 'email.complained',
                object: 'email',
                workspaceId: mailbox.workspaceId,
                actor: { kind: 'sync', id: mailbox.id },
                occurredAt: event.at.toISOString(),
                recordId: found.send.id,
                complaint: { mailboxId: mailbox.id, address: found.address, outboundId: found.send.id },
            }),
        );
        return 'recorded';
    }

    private async refused(clientIp: string): Promise<void> {
        const over = await this.limiter.hit(
            smtp2goHookRateKey(clientIp),
            SMTP2GO_HOOK_FAILURE_LIMIT,
            SMTP2GO_HOOK_FAILURE_WINDOW_S,
        );
        if (over) throw new RateLimited('too many refused deliveries; try again later');
    }

    private async note(mailbox: { id: string; workspaceId: string }, result: Smtp2GoHookResult): Promise<void> {
        await this.rls.withWorkspace(mailbox.workspaceId, (tx) =>
            tx.mailbox.update({ where: { id: mailbox.id }, data: { lastHookAt: new Date(), lastHookResult: result } }),
        );
    }
}

/** The send of this mailbox an event is about: by SMTP2Go's id for it, our Message-ID, or our send id. */
function sendOf(tx: WorkspaceClient, mailboxId: string, event: Read) {
    const or = [
        ...(event.emailId ? [{ providerMessageId: `${SMTP2GO_PROVIDER_PREFIX}${event.emailId}` }] : []),
        ...(event.messageId ? [{ rfc822MessageId: event.messageId }] : []),
        ...(event.crmId ? [{ id: event.crmId }] : []),
    ];
    if (or.length === 0) return Promise.resolve(null);
    return tx.mailOutbound.findFirst({
        where: { mailboxId, status: 'sent', OR: or },
        select: { id: true, personId: true, toAddresses: true },
    });
}

/** `Authorization: Bearer <secret>`, compared in constant time (over hashes, so the lengths always match). */
function bearerMatches(header: string | undefined, secret: string): boolean {
    const given = /^Bearer\s+(\S+)\s*$/i.exec(header ?? '')?.[1];
    if (!given) return false;
    return timingSafeEqual(Buffer.from(hashToken(given), 'hex'), Buffer.from(hashToken(secret), 'hex'));
}

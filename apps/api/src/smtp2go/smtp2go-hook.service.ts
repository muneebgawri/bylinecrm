import { timingSafeEqual } from 'node:crypto';
import { Injectable, NotFoundException } from '@nestjs/common';
import type { Smtp2GoHookResult } from '@bylinecrm/shared';
import { RateLimiter } from '../auth/rate-limiter.service';
import { hashToken } from '../auth/tokens';
import { DomainEvents } from '../events/domain-events.service';
import { ApiException, RateLimited } from '../infra/errors/api-errors';
import { MailSendService } from '../mail-send/mail-send.service';
import { PrismaService } from '../infra/prisma.service';
import { RlsPrismaService, type WorkspaceClient } from '../infra/rls-prisma.service';
import { SecretBox } from '../infra/secret-box';
import { recordProviderBounce } from '../sending-pool/bounces';
import { SuppressionService } from '../suppression/suppression.service';
import { TrackingService } from '../tracking/tracking.service';
import { parseSmtp2GoEvent, rejectedRecipient, type Smtp2GoEvent } from './smtp2go-event';
import type { MailOutboundStatus, SuppressionReason } from '@prisma/client';
import {
    SMTP2GO_HOOK_FAILURE_LIMIT,
    SMTP2GO_HOOK_FAILURE_WINDOW_S,
    SMTP2GO_PROVIDER_PREFIX,
    SMTP2GO_REJECTED,
    SMTP2GO_REJECTED_SUPPRESSED,
    smtp2goHookRateKey,
} from './smtp2go.constants';

type Read = Exclude<Smtp2GoEvent, { kind: 'other' }>;

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
 *   send already;
 * - `reject` (SMTP2Go took the API call, then refused the message) → the send `failed`, by the send job's one
 *   failure write (`MailSendService.failAfterSent`); the address suppressed when SMTP2Go's own suppressions were
 *   why, otherwise counted towards the mailbox's pause;
 * - `unsubscribe` (SMTP2Go's own footer) → the address suppressed as `unsubscribe` from the provider, as the
 *   CRM's own link does it;
 * - `delivered` → the send's `delivered_at`, the first report kept.
 * `processed` (the send is `sent` already) and `resubscribe` are acknowledged and ignored — an unsubscribe is
 * never lifted (`SuppressionService`), so a resubscribe at SMTP2Go does not make the CRM mail the address again.
 * Replies are never SMTP2Go's — they arrive in the mailbox the message's Reply-To names, as before. A redelivery
 * changes nothing.
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
        private readonly sends: MailSendService,
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
        if (event.kind === 'spam') return this.providerSuppression(mailbox, event, 'complaint');
        if (event.kind === 'unsubscribe') return this.providerSuppression(mailbox, event, 'unsubscribe');
        if (event.kind === 'reject') return this.rejected(mailbox, event);
        return this.rls.withWorkspace(mailbox.workspaceId, async (tx) => {
            const send = await sendOf(tx, mailbox.id, event);
            if (!send) return 'unmatched';
            if (event.kind === 'delivered') {
                const first = await tx.mailOutbound.updateMany({
                    where: { id: send.id, deliveredAt: null },
                    data: { deliveredAt: event.at },
                });
                return first.count === 1 ? 'recorded' : 'duplicate';
            }
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
     * SMTP2Go refused the message after taking the API call (`reject`). The send fails through the send job's one
     * failure write — as one SMTP2Go refused at the API does — so it is `failed`, `email.failed` is announced once,
     * its queued follow-ups are called off, and it no longer counts as sent for the mailbox's allowance and rates.
     * Whose doing it was decides the rest (`rejectedRecipient`):
     * - the recipient is on SMTP2Go's suppressions (`smtp2go.rejected_suppressed`) → the address is suppressed here
     *   too, from the provider, as the matching reason (hard bounce, complaint, unsubscribe), naming the send — so no
     *   path mails it again; a reason that does not say which kind suppresses nothing (it is still not ours);
     * - anything else (`smtp2go.rejected`: an unverified sender, a sandboxed or broken key) → it counts towards the
     *   mailbox's pause (`SendingPoolConsumer` → `evaluateRejects`), unless it is a test send.
     * A send already failed is a `duplicate`.
     */
    private async rejected(mailbox: { id: string; workspaceId: string }, event: Read): Promise<Smtp2GoHookResult> {
        const send = await this.rls.withWorkspace(mailbox.workspaceId, (tx) =>
            sendOf(tx, mailbox.id, event, ['sent', 'failed']),
        );
        if (!send) return 'unmatched';
        if (send.status === 'failed') return 'duplicate';
        const whose = rejectedRecipient(event.reason);
        const failed = await this.sends.failAfterSent(mailbox.workspaceId, send.id, {
            code: whose.recipient ? SMTP2GO_REJECTED_SUPPRESSED : SMTP2GO_REJECTED,
            message: `SMTP2Go rejected the message after taking it${event.reason ? ` (${event.reason})` : ''}`,
            at: event.at.toISOString(),
        });
        if (!failed) return 'duplicate';
        const address = event.address ?? send.toAddresses[0] ?? null;
        if (whose.recipient && whose.suppression && address) {
            await this.suppressions.suppress(mailbox.workspaceId, {
                address,
                reason: whose.suppression,
                source: 'provider',
                personId: send.personId,
                outboundId: send.id,
            });
        }
        return 'recorded';
    }

    /**
     * A spam complaint or an unsubscribe through SMTP2Go's footer: the address goes on the suppression list
     * (`complaint` / `unsubscribe`) from the provider, naming the send, through the one write every path uses — so
     * no path mails it again, and its enrolments stop. A complaint is what the pool's complaint rate counts
     * (`SendingPoolConsumer`) and is announced once as `email.complained`. One already recorded for this send is a
     * `duplicate`.
     */
    private async providerSuppression(
        mailbox: { id: string; workspaceId: string },
        event: Read,
        reason: Extract<SuppressionReason, 'complaint' | 'unsubscribe'>,
    ): Promise<Smtp2GoHookResult> {
        const found = await this.rls.withWorkspace(mailbox.workspaceId, async (tx) => {
            const send = await sendOf(tx, mailbox.id, event);
            if (!send) return null;
            const address = event.address ?? send.toAddresses[0] ?? null;
            if (!address) return null;
            const already = await tx.suppression.count({
                where: { address, reason, outboundId: send.id },
            });
            return { send, address, already: already > 0 };
        });
        if (!found) return 'unmatched';
        if (found.already) return 'duplicate';
        await this.suppressions.suppress(mailbox.workspaceId, {
            address: found.address,
            reason,
            source: 'provider',
            personId: found.send.personId,
            outboundId: found.send.id,
        });
        if (reason !== 'complaint') return 'recorded';
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

/**
 * The send of this mailbox an event is about: by SMTP2Go's id for it, our Message-ID, or our send id — one that went
 * (`statuses`: a reject also finds the one it already failed, so a redelivery is a `duplicate`).
 */
function sendOf(tx: WorkspaceClient, mailboxId: string, event: Read, statuses: MailOutboundStatus[] = ['sent']) {
    const or = [
        ...(event.emailId ? [{ providerMessageId: `${SMTP2GO_PROVIDER_PREFIX}${event.emailId}` }] : []),
        ...(event.messageId ? [{ rfc822MessageId: event.messageId }] : []),
        ...(event.crmId ? [{ id: event.crmId }] : []),
    ];
    if (or.length === 0) return Promise.resolve(null);
    return tx.mailOutbound.findFirst({
        where: { mailboxId, status: { in: statuses }, OR: or },
        select: { id: true, status: true, personId: true, toAddresses: true },
    });
}

/** `Authorization: Bearer <secret>`, compared in constant time (over hashes, so the lengths always match). */
function bearerMatches(header: string | undefined, secret: string): boolean {
    const given = /^Bearer\s+(\S+)\s*$/i.exec(header ?? '')?.[1];
    if (!given) return false;
    return timingSafeEqual(Buffer.from(hashToken(given), 'hex'), Buffer.from(hashToken(secret), 'hex'));
}

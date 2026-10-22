import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import type { DeliveredEvent } from '../events/outbox-consumer';
import { ApiException } from '../infra/errors/api-errors';
import { PrismaService } from '../infra/prisma.service';
import { RlsPrismaService, type WorkspaceClient } from '../infra/rls-prisma.service';
import { SecretBox } from '../infra/secret-box';
import { NEWSWIREOS_DEAL_WON_PORT, type DealWonBody, type NewswireosDealWonPort } from './deal-won-push.port';
import {
    DEAL_WON_PREVIEW_SCAN,
    DEAL_WON_PUSH_JOB,
    DEAL_WON_PUSH_QUEUE,
    OWNERSHIP_DELIVERIES_SHOWN,
    OWNERSHIP_PUSH_REASONS,
    OWNERSHIP_PUSH_STUCK_MS,
    OWNERSHIP_PUSH_SWEEP_MAX,
} from './invoices.constants';
import { NewswireosApiError } from './newswireos-verification.port';
import type { DealWonDeliveryView, DealWonPushPreview } from './responses';

export interface DealWonPushJob {
    workspaceId: string;
    deliveryId: string;
}

type DeliveryRow = Prisma.NewswireosDealWonDeliveryGetPayload<object>;

/**
 * PNW-766 (doc 11 §8s): won deals pushed to NewswireOS, which makes the deal's contact a client (or links the client
 * they already are) and gives it the deal owner's account manager. The ownership push's shape (PNW-765):
 *
 * - **Outbox-driven.** The `newswireos-deal-won` consumer hands every `deal.won` here, however the deal was won; an
 *   import's (a deal that came in already won) is history, not a win, and is not pushed.
 * - **Off by default.** Nothing is written or sent unless the workspace is linked and an admin turned the push on;
 *   a delivery queued before it was turned off is `skipped`, not sent.
 * - **One delivery per event**, keyed on the event's outbox id, which is also the push's `event_id`. Only a deal
 *   with a contact who has an email, a company (the deal's, else the contact's) and an owner is sent.
 * - **Retry.** No answer, a 5xx or a 429 is retried by the queue's backoff; any other 4xx is final; a 404 is
 *   `not_ready`. A 200 is final whatever it says, `NOT_A_CLIENT` included.
 * - **Kept.** NewswireOS's `customer_id` goes on the person; the company takes its client (a colleague's parent)
 *   when it has none yet.
 */
@Injectable()
export class DealWonPushService {
    constructor(
        private readonly rls: RlsPrismaService,
        private readonly ownerPrisma: PrismaService,
        private readonly secrets: SecretBox,
        @Inject(NEWSWIREOS_DEAL_WON_PORT) private readonly newswireos: NewswireosDealWonPort,
        @InjectQueue(DEAL_WON_PUSH_QUEUE) private readonly queue: Queue<DealWonPushJob>,
    ) {}

    /** Whether an event is one this push reads: a deal won by anything but an import. */
    static accepts(event: DeliveredEvent['event']): boolean {
        return event.type === 'deal.won' && event.internal !== true && event.actor.kind !== 'import';
    }

    /** The consumer's half: a delivery row and its job, when the push is on and the deal has what NewswireOS needs. */
    async enqueueForEvent(delivered: DeliveredEvent): Promise<void> {
        if (!DealWonPushService.accepts(delivered.event)) return;
        const workspaceId = delivered.event.workspaceId;
        const row = await this.rls.withWorkspace(workspaceId, async (tx) => {
            const link = await tx.newswireosSettings.findFirst({ select: { pushDealWon: true } });
            if (!link?.pushDealWon) return null;
            const existing = await tx.newswireosDealWonDelivery.findUnique({
                where: { workspaceId_eventId: { workspaceId, eventId: delivered.id } },
            });
            if (existing) return existing;
            const built = await bodyFor(tx, delivered.event.recordId, {
                id: delivered.id,
                occurredAt: delivered.event.occurredAt,
            });
            if (!built) return null;
            return tx.newswireosDealWonDelivery.create({
                data: {
                    workspaceId,
                    eventId: delivered.id,
                    opportunityId: delivered.event.recordId,
                    personId: built.personId,
                    companyId: built.companyId,
                    payload: built.body as unknown as Prisma.InputJsonValue,
                },
            });
        });
        if (row && (row.status === 'pending' || row.status === 'retrying')) {
            // Redis down throws to the relay, which retries; the row is keyed on the event, so nothing doubles.
            await this.queue.add(DEAL_WON_PUSH_JOB, { workspaceId, deliveryId: row.id }, { jobId: row.id });
        }
    }

    /**
     * Sends one delivery (the worker's half). `retry`: NewswireOS did not answer or failed on its side, and this is
     * not the last attempt; the caller throws so the queue tries again.
     */
    async deliver(workspaceId: string, deliveryId: string, opts: { finalAttempt: boolean }): Promise<'done' | 'retry'> {
        const { row, link } = await this.rls.withWorkspace(workspaceId, async (tx) => ({
            row: await tx.newswireosDealWonDelivery.findUnique({ where: { id: deliveryId } }),
            link: await tx.newswireosSettings.findFirst({
                select: { baseUrl: true, apiTokenCiphertext: true, pushDealWon: true },
            }),
        }));
        if (!row || (row.status !== 'pending' && row.status !== 'retrying')) return 'done';
        const settle = (data: Prisma.NewswireosDealWonDeliveryUpdateInput) =>
            this.rls.withWorkspace(workspaceId, (tx) =>
                tx.newswireosDealWonDelivery.update({ where: { id: deliveryId }, data }),
            );
        if (!link?.pushDealWon) {
            await settle({ status: 'skipped', reasonCode: OWNERSHIP_PUSH_REASONS.pushOff });
            return 'done';
        }
        const attempt = { attempts: { increment: 1 }, lastAttemptAt: new Date() };
        try {
            const answer = await this.newswireos.push(
                { baseUrl: link.baseUrl, apiToken: this.secrets.open(link.apiTokenCiphertext) },
                row.payload as unknown as DealWonBody,
            );
            await this.rls.withWorkspace(workspaceId, async (tx) => {
                await tx.newswireosDealWonDelivery.update({
                    where: { id: deliveryId },
                    data: {
                        ...attempt,
                        status: 'delivered',
                        httpStatus: 200,
                        customerId: answer.customerId,
                        parentCustomerId: answer.parentCustomerId,
                        reasonCode: answer.reasonCode,
                        amReasonCode: answer.amReasonCode,
                        lastError: null,
                    },
                });
                if (!answer.customerId) return;
                // The person's client is NewswireOS's latest answer; a company keeps the first client it was given.
                await tx.person.updateMany({
                    where: { id: row.personId },
                    data: { newswireosCustomerId: answer.customerId },
                });
                await tx.company.updateMany({
                    where: { id: row.companyId, newswireosCustomerId: null },
                    data: { newswireosCustomerId: answer.parentCustomerId ?? answer.customerId },
                });
            });
            return 'done';
        } catch (error) {
            const e =
                error instanceof NewswireosApiError
                    ? error
                    : new NewswireosApiError(null, error instanceof Error ? error.message : String(error));
            const failed = { ...attempt, httpStatus: e.status, lastError: e.message.slice(0, 500) };
            if (e.status === 404) {
                await settle({ ...failed, status: 'not_ready', reasonCode: OWNERSHIP_PUSH_REASONS.notReady });
                return 'done';
            }
            if (e.transient) {
                await settle({
                    ...failed,
                    status: opts.finalAttempt ? 'failed' : 'retrying',
                    reasonCode: e.reasonCode ?? OWNERSHIP_PUSH_REASONS.unavailable,
                });
                return opts.finalAttempt ? 'done' : 'retry';
            }
            const reasonCode =
                e.reasonCode ??
                (e.status === 401
                    ? OWNERSHIP_PUSH_REASONS.tokenRefused
                    : e.status === 403
                      ? OWNERSHIP_PUSH_REASONS.tokenLacksScope
                      : e.status === 400
                        ? OWNERSHIP_PUSH_REASONS.badRequest
                        : OWNERSHIP_PUSH_REASONS.rejected);
            await settle({ ...failed, status: 'failed', reasonCode });
            return 'done';
        }
    }

    /**
     * Queues again every delivery stuck `pending` past `OWNERSHIP_PUSH_STUCK_MS` whose job is gone, as the ownership
     * push's sweep does. Across workspaces, through the owner client. Returns how many were queued.
     */
    async sweep(now = Date.now()): Promise<number> {
        const stuck = await this.ownerPrisma.newswireosDealWonDelivery.findMany({
            where: { status: 'pending', createdAt: { lt: new Date(now - OWNERSHIP_PUSH_STUCK_MS) } },
            select: { id: true, workspaceId: true },
            orderBy: { createdAt: 'asc' },
            take: OWNERSHIP_PUSH_SWEEP_MAX,
        });
        let requeued = 0;
        for (const row of stuck) {
            if (await this.queue.getJob(row.id)) continue;
            await this.queue.add(
                DEAL_WON_PUSH_JOB,
                { workspaceId: row.workspaceId, deliveryId: row.id },
                { jobId: row.id },
            );
            requeued += 1;
        }
        return requeued;
    }

    /** Turns the push on or off (an admin's). Needs a link. */
    async setEnabled(enabled: boolean): Promise<void> {
        await this.rls.withWorkspace(async (tx) => {
            const existing = await tx.newswireosSettings.findFirst({ select: { id: true } });
            if (!existing) throw new ApiException(404, 'not_found', 'NewswireOS is not linked');
            await tx.newswireosSettings.update({ where: { id: existing.id }, data: { pushDealWon: enabled } });
        });
    }

    /** The latest deliveries, newest first. */
    deliveries(): Promise<DealWonDeliveryView[]> {
        return this.rls.withWorkspace(async (tx) =>
            (
                await tx.newswireosDealWonDelivery.findMany({
                    orderBy: { createdAt: 'desc' },
                    take: OWNERSHIP_DELIVERIES_SHOWN,
                })
            ).map(deliveryView),
        );
    }

    /**
     * A dry run: the body a push would send for the latest won deal that qualifies (a contact with an email, a
     * company, an owner), with a made-up `event_id` (a real push's is its `deal.won` event). Nothing is sent or
     * written; `found` false when no won deal qualifies. Looks at the latest `DEAL_WON_PREVIEW_SCAN` won deals only.
     */
    async preview(): Promise<DealWonPushPreview> {
        return this.rls.withWorkspace(async (tx) => {
            const deals = await tx.opportunity.findMany({
                where: {
                    deletedAt: null,
                    stage: { kind: 'won' },
                    pointOfContact: { deletedAt: null, emailPrimary: { not: null } },
                },
                select: { id: true, closedAt: true },
                orderBy: [{ closedAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
                take: DEAL_WON_PREVIEW_SCAN,
            });
            for (const deal of deals) {
                const built = await bodyFor(tx, deal.id, {
                    id: randomUUID(),
                    occurredAt: (deal.closedAt ?? new Date()).toISOString(),
                });
                if (built) return { sent: false, found: true, opportunityId: deal.id, payload: built.body };
            }
            return { sent: false, found: false, opportunityId: null, payload: null };
        });
    }
}

/**
 * The body for a won deal, sent as `event` (the push's `event_id` and `occurred_at`): the deal, its company (the
 * deal's, else its contact's), its contact and its owner (the deal's, else the contact's or the company's). Null
 * when NewswireOS could not take it: no contact with an email, no company, no owner, or the deal is no longer won.
 */
async function bodyFor(
    tx: WorkspaceClient,
    dealId: string,
    event: { id: string; occurredAt: string },
): Promise<{ body: DealWonBody; personId: string; companyId: string } | null> {
    const ownerEmail = { select: { user: { select: { email: true } } } } as const;
    const company = { select: { id: true, name: true, domain: true, owner: ownerEmail } } as const;
    const deal = await tx.opportunity.findUnique({
        where: { id: dealId },
        select: {
            id: true,
            name: true,
            amountMinor: true,
            currency: true,
            deletedAt: true,
            stage: { select: { kind: true } },
            owner: ownerEmail,
            company,
            pointOfContact: {
                select: {
                    id: true,
                    nameFirst: true,
                    nameLast: true,
                    emailPrimary: true,
                    deletedAt: true,
                    owner: ownerEmail,
                    company,
                },
            },
        },
    });
    if (!deal || deal.deletedAt || deal.stage.kind !== 'won') return null;
    const contact = deal.pointOfContact;
    if (!contact || contact.deletedAt || !contact.emailPrimary) return null;
    const at = deal.company ?? contact.company;
    const owner = deal.owner ?? contact.owner ?? at?.owner;
    if (!at || !owner) return null;
    const contactName = `${contact.nameFirst} ${contact.nameLast}`.trim();
    const amount = deal.amountMinor !== null ? Number(deal.amountMinor) : null;
    return {
        personId: contact.id,
        companyId: at.id,
        body: {
            event_id: event.id,
            occurred_at: event.occurredAt,
            deal: {
                byline_id: deal.id,
                name: deal.name,
                ...(amount !== null && Number.isSafeInteger(amount) ? { amount_minor: amount } : {}),
                currency: deal.currency,
            },
            company: { byline_id: at.id, name: at.name, ...(at.domain ? { domain: at.domain.toLowerCase() } : {}) },
            contact: {
                byline_id: contact.id,
                email: contact.emailPrimary,
                ...(contactName ? { name: contactName } : {}),
            },
            owner: { email: owner.user.email.toLowerCase() },
        },
    };
}

function deliveryView(row: DeliveryRow): DealWonDeliveryView {
    const body = row.payload as unknown as Partial<DealWonBody>;
    return {
        id: row.id,
        eventId: row.eventId,
        opportunityId: row.opportunityId,
        personId: row.personId,
        companyId: row.companyId,
        dealName: body.deal?.name ?? '',
        contactEmail: body.contact?.email ?? '',
        ownerEmail: body.owner?.email ?? '',
        status: row.status as DealWonDeliveryView['status'],
        attempts: row.attempts,
        customerId: row.customerId,
        parentCustomerId: row.parentCustomerId,
        reasonCode: row.reasonCode,
        amReasonCode: row.amReasonCode,
        httpStatus: row.httpStatus,
        lastError: row.lastError,
        lastAttemptAt: row.lastAttemptAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
    };
}

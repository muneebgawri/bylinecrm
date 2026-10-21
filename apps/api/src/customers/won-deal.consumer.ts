import { Injectable } from '@nestjs/common';
import { WON_DEAL_EXCLUSION_SOURCE, type DomainEvent } from '@bylinecrm/shared';
import { OutboxConsumerOf, type DeliveredEvent, type OutboxConsumer } from '../events/outbox-consumer';
import { RlsPrismaService, type WorkspaceClient } from '../infra/rls-prisma.service';
import { WonDealExclusions } from './won-deal-exclusions';

/**
 * #242: a won deal's customer is excluded from outreach (`deal.won`, however the deal was won). A deal that leaves its
 * won stage (`deal.stage_changed`, `deal.lost`), or whose invoices were refunded in full (`invoice.invalidated`,
 * `invoice.refunded`), has its automatic exclusion flagged for an admin — never removed. Both writes are idempotent.
 */
@Injectable()
@OutboxConsumerOf('won_deal_exclusions')
export class WonDealConsumer implements OutboxConsumer {
    constructor(
        private readonly rls: RlsPrismaService,
        private readonly won: WonDealExclusions,
    ) {}

    accepts(event: DomainEvent): boolean {
        return ['deal.won', 'deal.stage_changed', 'deal.lost', 'invoice.invalidated', 'invoice.refunded'].includes(
            event.type,
        );
    }

    async consume({ event }: DeliveredEvent): Promise<void> {
        const ws = event.workspaceId;
        await this.rls.withWorkspace(ws, async (tx) => {
            switch (event.type) {
                case 'deal.won':
                    await this.won.exclude(tx, ws, event.recordId);
                    return;
                case 'deal.stage_changed':
                case 'deal.lost':
                    if (!(await isWon(tx, event.recordId))) await this.won.flag(tx, event.recordId, 'deal_reopened');
                    return;
                default: {
                    const dealId = event.invoice?.opportunityId;
                    if (dealId && (await fullyRefunded(tx, dealId))) await this.won.flag(tx, dealId, 'deal_refunded');
                }
            }
        });
    }
}

async function isWon(tx: WorkspaceClient, dealId: string): Promise<boolean> {
    const deal = await tx.opportunity.findUnique({
        where: { id: dealId },
        select: { stage: { select: { kind: true } } },
    });
    return deal?.stage.kind === 'won';
}

/**
 * Whether a deal's won amount was given back in full: it has a live automatic exclusion, some refund on record, and
 * none of its verified invoices still counts anything (amount net of refunds).
 */
export async function fullyRefunded(tx: WorkspaceClient, dealId: string): Promise<boolean> {
    const excluded = await tx.outreachExclusion.count({
        where: { source: WON_DEAL_EXCLUSION_SOURCE, externalRef: dealId, removedAt: null },
    });
    if (excluded === 0) return false;
    const invoices = await tx.dealInvoice.findMany({
        where: { opportunityId: dealId },
        select: { status: true, amountMinor: true, refundedAmountMinor: true },
    });
    const refunded = invoices.some((i) => i.refundedAmountMinor > 0n);
    const stillCounts = invoices.some((i) => i.status === 'verified' && i.amountMinor - i.refundedAmountMinor > 0n);
    return refunded && !stillCounts;
}

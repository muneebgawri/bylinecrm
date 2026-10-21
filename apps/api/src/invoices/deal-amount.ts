import type { EventActor } from '@bylinecrm/shared';
import type { DomainEvents } from '../events/domain-events.service';
import type { WorkspaceClient } from '../infra/rls-prisma.service';
import { verifiedTotal } from './invoice-decision';

/**
 * A won deal with no amount takes the amount its verified invoices add up to (INV-1): in the deal's currency, net of
 * refunds. Called when a rule closes a deal Won and when an invoice is verified on a deal already Won. An amount
 * already there is never overwritten (the update is guarded on `amount_minor IS NULL`, so a member's edit made at
 * the same time wins). The change is an `opportunity.updated` with `diff.amount`, as any edit, so the timeline and
 * webhooks show it; `actor` is whoever closed the deal or verified the invoice. Returns the amount set, or null.
 */
export async function fillWonDealAmount(
    tx: WorkspaceClient,
    events: DomainEvents,
    dealId: string,
    actor: EventActor,
): Promise<bigint | null> {
    const deal = await tx.opportunity.findFirst({
        where: { id: dealId, deletedAt: null },
        select: { workspaceId: true, amountMinor: true, currency: true, stage: { select: { kind: true } } },
    });
    if (!deal || deal.amountMinor !== null || deal.stage.kind !== 'won') return null;
    const verified = await tx.dealInvoice.findMany({
        where: { opportunityId: dealId, status: 'verified' },
        select: { amountMinor: true, refundedAmountMinor: true, currency: true },
    });
    const total = verifiedTotal(deal.currency, verified);
    if (total <= 0n) return null;
    const { count } = await tx.opportunity.updateMany({
        where: { id: dealId, amountMinor: null },
        data: { amountMinor: total },
    });
    if (count === 0) return null;
    await events.record(tx, {
        type: 'opportunity.updated',
        object: 'opportunity',
        workspaceId: deal.workspaceId,
        actor,
        occurredAt: new Date().toISOString(),
        recordId: dealId,
        diff: { amount: { from: null, to: { amountMinor: Number(total), currency: deal.currency } } },
    });
    return total;
}

import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
    type NewswireosPaymentDecision,
    type NewswireosPaymentMatch,
    type NewswireosPaymentMode,
    type RecordObject,
} from '@bylinecrm/shared';
import { DomainEvents } from '../events/domain-events.service';
import { requireCallerMember } from '../infra/caller-member';
import { ApiException } from '../infra/errors/api-errors';
import { RlsPrismaService, type WorkspaceClient } from '../infra/rls-prisma.service';
import { WorkspaceContext, type WorkspaceRunContext } from '../infra/workspace-context';
import { notify } from '../notifications/notify';
import { OpportunitiesService } from '../records/opportunities.service';
import { NEWSWIREOS_TIMELINE_SOURCE } from './invoices.constants';
import { InvoicesService, invoiceReviewers } from './invoices.service';
import { matchClient, type TimelineDelivery } from './newswireos-timeline.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Row = Prisma.NewswireosPaymentGetPayload<object>;
type Target = { type: Extract<RecordObject, 'person' | 'company'>; id: string };

/** Which deal a payment goes on, before anything is done about it. */
interface Plan {
    decision: NewswireosPaymentDecision;
    matchedBy: NewswireosPaymentMatch | null;
    opportunityId: string | null;
    candidateIds: string[];
    target: Target | null;
    /** Who hears about it: the client's owner (`needs_deal`, `created_deal`), or the reviewers (`unmatched`). */
    ownerId: string | null;
    /** Once acted on: the invoice put on the deal, whose verification is queued after commit. */
    invoice?: { id: string; workspaceId: string };
}

/**
 * INV-2: a paid invoice NewswireOS reports (`invoice.paid` with its invoice number) goes on the client's deal, as an
 * Account Manager would enter it — `InvoicesService.attachIn`, then the same verification with NewswireOS, so the
 * same stage rule moves the deal once its verified invoices cover it, and a refund takes it back as before.
 *
 * Which deal, never guessed: the one NewswireOS names (`byline_opportunity_id`, set when the invoice was raised
 * from the CRM), else the client's only open deal. With none open, a deal is made for the payment and its owner is
 * told; with several, the owner is asked which. An invoice an Account Manager already entered is left alone.
 *
 * The workspace's `payment_mode` decides how far it goes: `off` (the timeline only), `shadow` (the decision is
 * recorded, nothing is done — to compare with what Account Managers enter) or `on`. Every decision is one
 * `newswireos_payments` row per invoice number, so a redelivery, or the invoice reported again, does nothing twice.
 */
@Injectable()
export class NewswireosPaymentsService {
    private readonly logger = new Logger(NewswireosPaymentsService.name);

    constructor(
        private readonly rls: RlsPrismaService,
        private readonly context: WorkspaceContext,
        private readonly events: DomainEvents,
        private readonly invoices: InvoicesService,
        private readonly opportunities: OpportunitiesService,
    ) {}

    /** Takes a paid invoice from the hook (a job, acting for the workspace). Returns what was decided, if anything. */
    async received(workspaceId: string, delivery: TimelineDelivery): Promise<NewswireosPaymentDecision | null> {
        if (delivery.type !== 'invoice.paid' || !delivery.invoiceNumber) return null;
        const invoiceNumber = delivery.invoiceNumber;
        const context: WorkspaceRunContext = {
            workspaceId,
            capabilities: new Set(),
            actor: { kind: 'sync', id: NEWSWIREOS_TIMELINE_SOURCE },
        };
        const settled = await this.context.run(context, () =>
            this.rls.withWorkspace(workspaceId, async (tx) => {
                const settings = await tx.newswireosSettings.findUnique({
                    where: { workspaceId },
                    select: { paymentMode: true },
                });
                const mode = (settings?.paymentMode ?? 'off') as NewswireosPaymentMode;
                if (mode === 'off') return null;
                const known = await tx.newswireosPayment.findUnique({
                    where: { workspaceId_invoiceNumber: { workspaceId, invoiceNumber } },
                    select: { id: true },
                });
                if (known) return null;
                const plan = await planFor(tx, workspaceId, delivery, invoiceNumber);
                const acted = mode === 'on' ? await this.act(tx, context, delivery, invoiceNumber, plan) : plan;
                const row = await tx.newswireosPayment.create({
                    data: {
                        workspaceId,
                        eventId: delivery.id,
                        invoiceNumber,
                        paymentMethod: delivery.paymentMethod,
                        amountMinor: delivery.amount ? BigInt(delivery.amount.amountMinor) : null,
                        currency: delivery.amount?.currency ?? null,
                        clientName: delivery.client?.name ?? null,
                        clientEmail: delivery.client?.email ?? null,
                        namedOpportunityId: delivery.bylineOpportunityId,
                        targetType: acted.target?.type ?? null,
                        targetId: acted.target?.id ?? null,
                        mode,
                        decision: acted.decision,
                        matchedBy: acted.matchedBy,
                        opportunityId: acted.opportunityId,
                        candidateIds: acted.candidateIds,
                        occurredAt: delivery.occurredAt,
                    },
                });
                if (mode === 'on') await this.tell(tx, workspaceId, row, acted);
                return { row, acted, mode };
            }),
        );
        if (!settled) return null;
        // The verification is queued once the payment is committed on its deal, as an entered invoice's is.
        if (settled.mode === 'on' && settled.acted.invoice) await this.invoices.verifyLater(settled.acted.invoice);
        return settled.row.decision as NewswireosPaymentDecision;
    }

    /** The latest reported payments, and whether an Account Manager entered the same invoice (shadow mode's check). */
    async list(limit = 100) {
        return this.rls.withWorkspace(async (tx) => {
            const rows = await tx.newswireosPayment.findMany({
                orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
                take: limit,
                include: { opportunity: { select: { name: true } } },
            });
            const entered = await tx.dealInvoice.findMany({
                where: { gateway: 'newswireos_invoice', reference: { in: rows.map((r) => r.invoiceNumber) } },
                select: { reference: true, opportunityId: true, createdById: true },
            });
            const byReference = new Map(entered.map((e) => [e.reference, e] as const));
            const names = await dealNames(
                tx,
                rows.flatMap((r) => r.candidateIds),
            );
            return rows.map((r) => {
                const hand = byReference.get(r.invoiceNumber);
                // An invoice entered by a person (not by this service, which enters as no member).
                const byHand = hand && hand.createdById !== null ? hand : null;
                return {
                    ...paymentView(r, names),
                    enteredOnOpportunityId: byHand?.opportunityId ?? null,
                    agrees: byHand ? byHand.opportunityId === r.opportunityId : null,
                };
            });
        });
    }

    /** One payment, for the page a `payment_*` notification opens. */
    async get(paymentId: string) {
        return this.rls.withWorkspace(async (tx) => {
            const row = await tx.newswireosPayment.findUnique({
                where: { id: paymentId },
                include: { opportunity: { select: { name: true } } },
            });
            if (!row) throw new NotFoundException('no such payment');
            return paymentView(row, await dealNames(tx, row.candidateIds));
        });
    }

    /**
     * A person chooses the deal for a payment the CRM would not guess (`needs_deal`, `unmatched`): it goes on that
     * deal as if they had entered it themselves. Their own deal, or any deal for whoever may verify invoices.
     */
    async choose(paymentId: string, opportunityId: string) {
        const context = this.current();
        const result = await this.rls.withWorkspace(async (tx) => {
            const me = await requireCallerMember(tx, context);
            const row = await tx.newswireosPayment.findUnique({ where: { id: paymentId } });
            if (!row) throw new NotFoundException('no such payment');
            if (row.mode !== 'on' || (row.decision !== 'needs_deal' && row.decision !== 'unmatched')) {
                throw new ApiException(409, 'conflict', 'this payment is not waiting for a deal');
            }
            if (row.resolvedAt) throw new ApiException(409, 'conflict', 'this payment is already on a deal');
            const deal = await tx.opportunity.findFirst({
                where: { id: opportunityId, deletedAt: null },
                select: { id: true, ownerId: true },
            });
            if (!deal) throw new NotFoundException('no such deal');
            const reviewer = (await invoiceReviewers(tx)).includes(me);
            if (!reviewer && deal.ownerId !== me) {
                throw new ForbiddenException(
                    'only the deal’s owner, or whoever verifies invoices, puts a payment on it',
                );
            }
            const invoice = await this.invoices.attachIn(tx, context, deal.id, paymentInvoice(row));
            const updated = await tx.newswireosPayment.update({
                where: { id: row.id },
                data: { opportunityId: deal.id, resolvedAt: new Date(), resolvedById: me },
                include: { opportunity: { select: { name: true } } },
            });
            await tx.notification.updateMany({
                where: { newswireosPaymentId: row.id, readAt: null },
                data: { readAt: new Date() },
            });
            return { invoice, view: paymentView(updated, await dealNames(tx, updated.candidateIds)) };
        });
        await this.invoices.verifyLater(result.invoice);
        return result.view;
    }

    /** `on`: puts the payment on the planned deal — or a new one — and says what was done. */
    private async act(
        tx: WorkspaceClient,
        context: WorkspaceRunContext,
        delivery: TimelineDelivery,
        invoiceNumber: string,
        plan: Plan,
    ): Promise<Plan & { invoice?: { id: string; workspaceId: string } }> {
        const input = {
            gateway: 'newswireos_invoice' as const,
            reference: invoiceNumber,
            ...(delivery.amount
                ? { expectedAmountMinor: String(delivery.amount.amountMinor), currency: delivery.amount.currency }
                : {}),
        };
        if (plan.decision === 'attached' && plan.opportunityId) {
            try {
                const invoice = await this.invoices.attachIn(tx, context, plan.opportunityId, input);
                return { ...plan, invoice };
            } catch (error) {
                // The deal refused it (no amount to expect, a payment already elsewhere): a person decides, as for
                // several open deals, rather than the hook failing and NewswireOS retrying for ever.
                if (!(error instanceof ApiException)) throw error;
                this.logger.warn(`payment ${invoiceNumber} not attached to ${plan.opportunityId}: ${error.message}`);
                return {
                    ...plan,
                    decision: 'needs_deal',
                    matchedBy: null,
                    opportunityId: null,
                    candidateIds: [plan.opportunityId],
                };
            }
        }
        if (plan.decision === 'created_deal' && plan.target) {
            const opportunityId = await this.dealFor(tx, context, delivery, invoiceNumber, plan);
            const invoice = await this.invoices.attachIn(tx, context, opportunityId, input);
            const owner = await tx.opportunity.findUnique({ where: { id: opportunityId }, select: { ownerId: true } });
            return { ...plan, opportunityId, ownerId: owner?.ownerId ?? plan.ownerId, invoice };
        }
        return plan;
    }

    /**
     * A deal made for a payment from a client with no open deal: theirs (the record's owner, as any deal at that
     * company is — OWN-2), in the starting stage, for the amount paid. The invoice then closes it through the stage
     * rule, as it would any deal.
     */
    private async dealFor(
        tx: WorkspaceClient,
        context: WorkspaceRunContext,
        delivery: TimelineDelivery,
        invoiceNumber: string,
        plan: Plan,
    ): Promise<string> {
        const target = plan.target!;
        const person =
            target.type === 'person'
                ? await tx.person.findUnique({ where: { id: target.id }, select: { id: true, companyId: true } })
                : null;
        const companyId = target.type === 'company' ? target.id : (person?.companyId ?? null);
        // Named as the CRM knows the client — their company, as deals are — else as NewswireOS names them.
        const client =
            (companyId ? await recordName(tx, { type: 'company', id: companyId }) : null) ??
            delivery.client?.name ??
            (await recordName(tx, target)) ??
            'NewswireOS client';
        const created = await this.opportunities.createIn(tx, context, {
            name: `${client} — NewswireOS payment`,
            ...(delivery.amount
                ? { amount: { amountMinor: delivery.amount.amountMinor, currency: delivery.amount.currency } }
                : {}),
            ...(companyId ? { companyId } : {}),
            ...(person ? { pointOfContactId: person.id } : {}),
            ...(plan.ownerId ? { ownerId: plan.ownerId } : {}),
            leadSource: 'NewswireOS',
        });
        await this.events.record(tx, created.event);
        for (const e of created.taskEvents) await this.events.record(tx, e);
        return created.row.id;
    }

    /** Tells whoever the decision is for: the owner, to choose or to know of the new deal; reviewers, of a stranger. */
    private async tell(tx: WorkspaceClient, workspaceId: string, row: Row, plan: Plan): Promise<void> {
        const target = [{ type: 'payment' as const, id: row.id }];
        if (plan.decision === 'needs_deal' || plan.decision === 'created_deal') {
            const recipients = plan.ownerId ? [plan.ownerId] : await invoiceReviewers(tx);
            const kind = plan.decision === 'needs_deal' ? 'payment_needs_deal' : 'payment_created_deal';
            await notify(tx, workspaceId, recipients, kind, target);
        } else if (plan.decision === 'unmatched') {
            await notify(tx, workspaceId, await invoiceReviewers(tx), 'payment_unmatched', target);
        }
    }

    private current(): WorkspaceRunContext {
        const context = this.context.get();
        if (!context) throw new Error('NewswireosPaymentsService is used inside a workspace scope');
        return context;
    }
}

/** Which deal the payment goes on, decided from what is in the CRM now; nothing is written. */
export async function planFor(
    tx: WorkspaceClient,
    workspaceId: string,
    delivery: TimelineDelivery,
    invoiceNumber: string,
): Promise<Plan> {
    const none = { matchedBy: null, candidateIds: [] as string[], ownerId: null };
    const entered = await tx.dealInvoice.findUnique({
        where: {
            workspaceId_gateway_reference: {
                workspaceId,
                gateway: 'newswireos_invoice',
                reference: invoiceNumber,
            },
        },
        select: { opportunityId: true, status: true },
    });
    const match = delivery.client ? await matchClient(tx, delivery.client) : null;
    const target: Target | null = match ? { type: match.target.type as Target['type'], id: match.target.id } : null;
    if (entered && entered.status !== 'invalid') {
        return { ...none, decision: 'already_on_deal', opportunityId: entered.opportunityId, target };
    }
    const named = delivery.bylineOpportunityId;
    if (named && UUID.test(named)) {
        const deal = await tx.opportunity.findFirst({
            where: { id: named, deletedAt: null },
            select: { id: true, ownerId: true },
        });
        if (deal) {
            return {
                ...none,
                decision: 'attached',
                matchedBy: 'deal_id',
                opportunityId: deal.id,
                ownerId: deal.ownerId,
                target,
            };
        }
    }
    if (!target) return { ...none, decision: 'unmatched', opportunityId: null, target: null };
    const record: { ownerId: string | null; companyId: string | null } | null =
        target.type === 'person'
            ? await tx.person.findUnique({ where: { id: target.id }, select: { ownerId: true, companyId: true } })
            : await tx.company
                  .findUnique({ where: { id: target.id }, select: { ownerId: true } })
                  .then((c) => (c ? { ownerId: c.ownerId, companyId: target.id } : null));
    const companyId = record?.companyId ?? null;
    const open = await tx.opportunity.findMany({
        where: {
            deletedAt: null,
            closedAt: null,
            OR: [
                ...(target.type === 'person' ? [{ pointOfContactId: target.id }] : []),
                ...(companyId ? [{ companyId }] : []),
            ],
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true, ownerId: true },
    });
    const ownerId = record?.ownerId ?? null;
    if (open.length === 1) {
        return {
            ...none,
            decision: 'attached',
            matchedBy: 'only_open_deal',
            opportunityId: open[0]!.id,
            ownerId: open[0]!.ownerId ?? ownerId,
            target,
        };
    }
    if (open.length === 0) return { ...none, decision: 'created_deal', opportunityId: null, ownerId, target };
    return {
        ...none,
        decision: 'needs_deal',
        opportunityId: null,
        candidateIds: open.map((d) => d.id),
        ownerId: ownerId ?? open[0]!.ownerId,
        target,
    };
}

/** What a chosen deal takes from the payment: the invoice as NewswireOS numbered it, for what was paid. */
function paymentInvoice(row: Row) {
    return {
        gateway: 'newswireos_invoice' as const,
        reference: row.invoiceNumber,
        ...(row.amountMinor !== null && row.currency
            ? { expectedAmountMinor: row.amountMinor.toString(), currency: row.currency }
            : {}),
    };
}

async function recordName(tx: WorkspaceClient, target: Target): Promise<string | null> {
    if (target.type === 'company') {
        return (await tx.company.findUnique({ where: { id: target.id }, select: { name: true } }))?.name ?? null;
    }
    const p = await tx.person.findUnique({ where: { id: target.id }, select: { nameFirst: true, nameLast: true } });
    return p ? `${p.nameFirst} ${p.nameLast}`.trim() || null : null;
}

async function dealNames(tx: WorkspaceClient, ids: readonly string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const deals = await tx.opportunity.findMany({
        where: { id: { in: [...new Set(ids)] }, deletedAt: null },
        select: { id: true, name: true },
    });
    return new Map(deals.map((d) => [d.id, d.name] as const));
}

export function paymentView(row: Row & { opportunity: { name: string } | null }, names: ReadonlyMap<string, string>) {
    return {
        id: row.id,
        invoiceNumber: row.invoiceNumber,
        paymentMethod: row.paymentMethod,
        amount:
            row.amountMinor !== null && row.currency
                ? { amountMinor: Number(row.amountMinor), currency: row.currency }
                : null,
        clientName: row.clientName,
        clientEmail: row.clientEmail,
        mode: row.mode as NewswireosPaymentMode,
        decision: row.decision as NewswireosPaymentDecision,
        matchedBy: (row.matchedBy as NewswireosPaymentMatch | null) ?? null,
        opportunityId: row.opportunityId,
        opportunityName: row.opportunity?.name ?? null,
        candidates: row.candidateIds.filter((id) => names.has(id)).map((id) => ({ id, name: names.get(id)! })),
        resolvedAt: row.resolvedAt?.toISOString() ?? null,
        occurredAt: row.occurredAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
    };
}

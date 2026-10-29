import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
    INVOICE_GATEWAYS,
    type Actor,
    type DealInvoiceView,
    type DomainEvent,
    type InvoiceGateway,
} from '@bylinecrm/shared';
import { DomainEvents } from '../events/domain-events.service';
import { requireCallerMember } from '../infra/caller-member';
import { ApiException } from '../infra/errors/api-errors';
import { RlsPrismaService, type WorkspaceClient } from '../infra/rls-prisma.service';
import { SecretBox } from '../infra/secret-box';
import { WorkspaceContext, type WorkspaceRunContext } from '../infra/workspace-context';
import { actorOf } from '../records/actor';
import { recordWhere } from '../records/record-scope';
import { fillWonDealAmount } from './deal-amount';
import { covers, settle, type Settlement } from './invoice-decision';
import { InvoiceQueue } from './invoice-queue';
import { isFreeMailDomain } from '../enrichment/email-domain';
import { INVOICE_REASONS, NEWSWIREOS_CLIENT_EMAILS_MAX } from './invoices.constants';
import {
    NEWSWIREOS_VERIFICATION_PORT,
    type NewswireosLookupResult,
    type NewswireosVerificationPort,
} from './newswireos-verification.port';

type Row = Prisma.DealInvoiceGetPayload<object>;

/** What a person enters on the deal. */
export interface NewInvoice {
    gateway: InvoiceGateway;
    reference: string;
    /** Defaults to the deal's amount; less for a partial payment. */
    expectedAmountMinor?: string | undefined;
    currency?: string | undefined;
    attachmentId?: string | undefined;
}

/** What the hook was told: a payment was refunded, disputed, or verified by finance in NewswireOS. */
export interface PaymentStateChange {
    type: 'payment.refunded' | 'payment.disputed' | 'payment.verified';
    gateway: string;
    references: string[];
    /** NewswireOS's reason: on `payment.verified`, null or `UNDERPAID_WITHIN_TOLERANCE`. */
    reasonCode: string | null;
    /** On a refund: NewswireOS's running total refunded, in minor units; `null` means all of it. */
    refundedCents: number | null;
    detail: Record<string, unknown>;
}

/** A refund, a chargeback: these take a payment back. */
const OPEN_OR_VERIFIED = ['verifying', 'verified', 'needs_review'] as const;
/** What a person (or finance in NewswireOS) may decide. */
const UNDECIDED = ['verifying', 'needs_review'] as const;

/**
 * Invoices on a deal (INV-1, FR-CRMS-19). A reference entered on a deal is `verifying` until NewswireOS answers
 * (in the background, `InvoicesWorkers`): `verified` attaches it, `invalid` refuses it with NewswireOS's reason,
 * and anything NewswireOS cannot decide is `needs_review` — a badge on the deal and a notification to whoever may
 * verify invoices by hand (`invoice:verify`). A workspace with no NewswireOS link, and a bank transfer (no feed),
 * go straight to `needs_review`. A refund or chargeback NewswireOS reports takes a verified invoice back
 * (`invalidated`). One payment is one deal: `(workspace, gateway, reference)` is unique.
 *
 * `invoice.verified` names the deal in `related` once its verified invoices cover its amount, so a stage rule on
 * that event moves it then.
 */
@Injectable()
export class InvoicesService {
    private readonly logger = new Logger(InvoicesService.name);

    constructor(
        private readonly rls: RlsPrismaService,
        private readonly context: WorkspaceContext,
        private readonly events: DomainEvents,
        private readonly queue: InvoiceQueue,
        private readonly secrets: SecretBox,
        @Inject(NEWSWIREOS_VERIFICATION_PORT) private readonly newswireos: NewswireosVerificationPort,
    ) {}

    // ── A person, on the deal ────────────────────────────────────────────────────────────────

    list(opportunityId: string): Promise<DealInvoiceView[]> {
        const context = this.current();
        return this.rls.withWorkspace(async (tx) => {
            await dealFor(tx, context, opportunityId);
            const rows = await tx.dealInvoice.findMany({
                where: { opportunityId },
                orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
            });
            return rows.map(view);
        });
    }

    /**
     * Enters a reference and queues its verification. The same payment on another deal (or already on this one,
     * and not refused) is `409`; a refused one entered again is asked again, with what is entered now.
     */
    async create(opportunityId: string, input: NewInvoice): Promise<DealInvoiceView> {
        const context = this.current();
        const row = await this.rls.withWorkspace((tx) => this.attachIn(tx, context, opportunityId, input));
        await this.verifyLater(row);
        return view(row);
    }

    /**
     * Puts a payment on a deal, in the caller's transaction: what `create` does for a person, and what a paid
     * invoice NewswireOS reports does (INV-2) — one path, so the same checks, verification and stage rule apply.
     * The caller queues the verification (`verifyLater`) once the transaction has committed.
     */
    async attachIn(
        tx: WorkspaceClient,
        context: WorkspaceRunContext,
        opportunityId: string,
        input: NewInvoice,
    ): Promise<Row> {
        const reference = input.reference.trim();
        {
            const deal = await dealFor(tx, context, opportunityId);
            const amountMinor = input.expectedAmountMinor ? BigInt(input.expectedAmountMinor) : deal.amountMinor;
            if (amountMinor === null || amountMinor <= 0n) {
                throw new ApiException(422, 'unprocessable', 'the deal has no amount: enter the amount expected', [
                    { path: 'expectedAmountMinor', message: 'REQUIRED' },
                ]);
            }
            const currency = (input.currency ?? deal.currency).toUpperCase();
            if (input.attachmentId) {
                const file = await tx.attachment.findFirst({
                    where: {
                        id: input.attachmentId,
                        targetType: 'opportunity',
                        targetId: opportunityId,
                        deletedAt: null,
                    },
                    select: { id: true },
                });
                if (!file) {
                    throw new ApiException(422, 'unprocessable', 'the receipt must be a file on this deal', [
                        { path: 'attachmentId', message: 'NOT_ON_DEAL' },
                    ]);
                }
            }
            const createdById = context.memberId ?? null;
            const fields = {
                amountMinor,
                currency,
                attachmentId: input.attachmentId ?? null,
                status: 'verifying' as const,
                reasonCode: null,
                note: null,
                verifiedAt: null,
                invalidatedAt: null,
                canonicalReference: null,
                resolvedGateway: null,
                verificationPayload: {},
                createdById,
                decidedById: null,
            };
            const existing = await tx.dealInvoice.findUnique({
                where: {
                    workspaceId_gateway_reference: {
                        workspaceId: context.workspaceId,
                        gateway: input.gateway,
                        reference,
                    },
                },
            });
            if (existing) {
                if (existing.status !== 'invalid' || existing.opportunityId !== opportunityId) {
                    // Another deal's is not this caller's to see: say only that the payment is taken.
                    throw new ApiException(409, 'conflict', 'this payment is already on a deal', undefined, {
                        reason: 'INVOICE_TAKEN',
                    });
                }
                return tx.dealInvoice.update({ where: { id: existing.id }, data: fields });
            }
            try {
                return await tx.dealInvoice.create({
                    data: {
                        workspaceId: context.workspaceId,
                        opportunityId,
                        gateway: input.gateway,
                        reference,
                        ...fields,
                    },
                });
            } catch (error) {
                if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
                    throw new ApiException(409, 'conflict', 'this payment is already on a deal', undefined, {
                        reason: 'INVOICE_TAKEN',
                    });
                }
                throw error;
            }
        }
    }

    /** Queues an entered invoice's verification with NewswireOS. */
    verifyLater(row: Pick<Row, 'id' | 'workspaceId'>): Promise<void> {
        return this.queue.enqueue({ workspaceId: row.workspaceId, invoiceId: row.id });
    }

    /** Verifies an undecided invoice by hand (`invoice:verify`): NewswireOS could not, or there is no link. */
    verifyByHand(opportunityId: string, invoiceId: string, note?: string): Promise<DealInvoiceView> {
        return this.decideByHand(opportunityId, invoiceId, 'verified', note ?? null);
    }

    /** Refuses an undecided invoice by hand (`invoice:verify`), with why. */
    rejectByHand(opportunityId: string, invoiceId: string, reason: string): Promise<DealInvoiceView> {
        return this.decideByHand(opportunityId, invoiceId, 'invalid', reason);
    }

    /** Asks NewswireOS again about an invoice waiting for finance (a fixed link, a confirmed transfer). */
    async recheck(opportunityId: string, invoiceId: string): Promise<DealInvoiceView> {
        const context = this.current();
        const row = await this.rls.withWorkspace(async (tx) => {
            await dealFor(tx, context, opportunityId);
            const found = await invoiceOn(tx, opportunityId, invoiceId);
            if (found.status !== 'needs_review') {
                throw new ApiException(409, 'conflict', 'only an invoice waiting for finance can be checked again');
            }
            return tx.dealInvoice.update({
                where: { id: invoiceId },
                data: { status: 'verifying', reasonCode: null },
            });
        });
        await this.queue.enqueue({ workspaceId: context.workspaceId, invoiceId });
        return view(row);
    }

    private async decideByHand(
        opportunityId: string,
        invoiceId: string,
        status: 'verified' | 'invalid',
        note: string | null,
    ): Promise<DealInvoiceView> {
        const context = this.current();
        return this.rls.withWorkspace(async (tx) => {
            await dealFor(tx, context, opportunityId);
            await invoiceOn(tx, opportunityId, invoiceId);
            const me = await requireCallerMember(tx, context);
            const outcome: Settlement = {
                status,
                reasonCode: INVOICE_REASONS.manual,
                canonicalReference: null,
                facts: {},
            };
            const row = await this.apply(tx, context.workspaceId, invoiceId, outcome, actorOf(context), {
                decidedById: me,
                note,
            });
            if (!row) throw new ApiException(409, 'conflict', 'this invoice is already decided');
            return view(row);
        });
    }

    // ── In the background ────────────────────────────────────────────────────────────────────

    /**
     * Verifies one invoice (the worker's job; the cross-tenant suite calls it directly). Idempotent: an invoice no
     * longer `verifying` is left alone. Throws only to be retried — NewswireOS not answering, before the last try.
     */
    async runVerification(workspaceId: string, invoiceId: string, opts: { finalAttempt: boolean }): Promise<void> {
        const found = await this.rls.withWorkspace(workspaceId, async (tx) => {
            const row = await tx.dealInvoice.findUnique({ where: { id: invoiceId } });
            const link = await tx.newswireosSettings.findFirst({
                select: { baseUrl: true, apiTokenCiphertext: true },
            });
            const client = row ? await clientOf(tx, row.opportunityId) : { emails: [], domain: null };
            return { row, link, client };
        });
        const { row, link, client } = found;
        if (!row || row.status !== 'verifying') return;

        let outcome: Settlement | 'retry';
        if (row.gateway === 'bank_wire') {
            outcome = {
                status: 'needs_review',
                reasonCode: INVOICE_REASONS.bankWire,
                canonicalReference: null,
                facts: {},
            };
        } else if (!link) {
            outcome = {
                status: 'needs_review',
                reasonCode: INVOICE_REASONS.noLink,
                canonicalReference: null,
                facts: {},
            };
        } else {
            let result: NewswireosLookupResult | null = null;
            let error: unknown = null;
            const nwLink = { baseUrl: link.baseUrl, apiToken: this.secrets.open(link.apiTokenCiphertext) };
            const ask = (named: boolean) =>
                this.newswireos.lookup(nwLink, {
                    gateway: row.gateway as Exclude<typeof row.gateway, 'bank_wire'>,
                    reference: row.reference,
                    amountCents: Number(row.amountMinor),
                    currency: row.currency.toLowerCase(),
                    ...(named && client.emails.length ? { clientEmails: client.emails } : {}),
                    ...(named && client.domain ? { clientDomain: client.domain } : {}),
                });
            try {
                // Always with who the client is (newswireos#647).
                result = await ask(true);
                // `held` means NewswireOS was told no client to compare: asked once more with the addresses, if
                // there are any (a deal with none stays `needs_review`).
                if (result.holder === 'held' && client.emails.length > 0) result = await ask(true);
            } catch (e) {
                error = e;
            }
            outcome = result
                ? settle({ result }, row.gateway)
                : settle({ error, finalAttempt: opts.finalAttempt }, row.gateway);
            if (outcome === 'retry') {
                this.logger.warn(`invoice ${invoiceId}: NewswireOS did not answer; trying again`);
                throw error instanceof Error ? error : new Error('NewswireOS did not answer');
            }
        }
        const settled = outcome;
        await this.rls.withWorkspace(workspaceId, (tx) =>
            this.apply(tx, workspaceId, invoiceId, settled, { kind: 'system', id: null }, {}),
        );
    }

    /**
     * What the NewswireOS hook was told, applied in its workspace: a refund or chargeback takes back every invoice
     * on that payment that is not already refused; a verification by finance settles one waiting for it.
     * Returns how many invoices changed.
     */
    async applyPaymentState(workspaceId: string, change: PaymentStateChange): Promise<number> {
        if (!(INVOICE_GATEWAYS as readonly string[]).includes(change.gateway) || change.references.length === 0) {
            return 0;
        }
        const gateway = change.gateway as InvoiceGateway;
        const actor: Actor = { kind: 'system', id: null };
        return this.rls.withWorkspace(workspaceId, async (tx) => {
            const rows = await tx.dealInvoice.findMany({
                where: {
                    OR: [
                        {
                            gateway,
                            OR: [
                                { reference: { in: change.references } },
                                { canonicalReference: { in: change.references } },
                            ],
                        },
                        // Entered as a NewswireOS invoice number: NewswireOS named the payment behind it.
                        {
                            gateway: 'newswireos_invoice',
                            resolvedGateway: gateway,
                            canonicalReference: { in: change.references },
                        },
                    ],
                },
            });
            let changed = 0;
            for (const row of rows) {
                if (change.type === 'payment.verified') {
                    const done = await this.apply(
                        tx,
                        workspaceId,
                        row.id,
                        {
                            status: 'verified',
                            reasonCode: change.reasonCode,
                            canonicalReference: null,
                            facts: { finance: change.detail },
                        },
                        actor,
                        { only: ['needs_review'] },
                    );
                    if (done) changed += 1;
                    continue;
                }
                if (!(OPEN_OR_VERIFIED as readonly string[]).includes(row.status)) continue;
                const coveredBefore = await coverage(tx, row.opportunityId);
                const payload = {
                    ...(row.verificationPayload as Prisma.JsonObject),
                    [change.type]: change.detail as Prisma.InputJsonObject,
                };
                // A refund names NewswireOS's running total; one short of the invoice leaves it counting, net.
                const refunded = change.type === 'payment.refunded' ? change.refundedCents : null;
                const partial = refunded !== null && BigInt(refunded) < row.amountMinor;
                let updated: Row;
                if (partial) {
                    if (BigInt(refunded) <= row.refundedAmountMinor) continue; // a replay, or an older total
                    updated = await tx.dealInvoice.update({
                        where: { id: row.id },
                        data: { refundedAmountMinor: BigInt(refunded), verificationPayload: payload },
                    });
                    await this.events.record(tx, await this.event(tx, 'invoice.refunded', updated, actor));
                } else {
                    updated = await tx.dealInvoice.update({
                        where: { id: row.id },
                        data: {
                            status: 'invalidated',
                            reasonCode:
                                change.type === 'payment.refunded'
                                    ? INVOICE_REASONS.refunded
                                    : INVOICE_REASONS.disputed,
                            invalidatedAt: new Date(),
                            ...(change.type === 'payment.refunded' ? { refundedAmountMinor: row.amountMinor } : {}),
                            verificationPayload: payload,
                        },
                    });
                    await this.events.record(tx, await this.event(tx, 'invoice.invalidated', updated, actor));
                }
                // The deal was paid and no longer is: whoever may verify invoices is told. A won deal stays won.
                if (coveredBefore && !(await coverage(tx, row.opportunityId))) {
                    await notifyReviewers(tx, workspaceId, row.id, 'invoice_coverage_lost');
                }
                changed += 1;
            }
            return changed;
        });
    }

    // ── One place an invoice is settled ──────────────────────────────────────────────────────

    /**
     * Settles an undecided invoice in `tx`: the state, the event on `verified`, and the notification on
     * `needs_review`. `null` when it was already decided (a concurrent decision won).
     */
    private async apply(
        tx: WorkspaceClient,
        workspaceId: string,
        invoiceId: string,
        outcome: Settlement,
        actor: Actor,
        opts: { decidedById?: string; note?: string | null; only?: readonly ('verifying' | 'needs_review')[] },
    ): Promise<Row | null> {
        const current = await tx.dealInvoice.findUnique({ where: { id: invoiceId } });
        const allowed = opts.only ?? UNDECIDED;
        if (!current || !(allowed as readonly string[]).includes(current.status)) return null;
        const { count } = await tx.dealInvoice.updateMany({
            where: { id: invoiceId, status: current.status },
            data: {
                status: outcome.status,
                reasonCode: outcome.reasonCode,
                verifiedAt: outcome.status === 'verified' ? new Date() : null,
                ...(outcome.canonicalReference ? { canonicalReference: outcome.canonicalReference } : {}),
                ...(outcome.resolvedGateway && current.gateway === 'newswireos_invoice'
                    ? { resolvedGateway: outcome.resolvedGateway }
                    : {}),
                verificationPayload: {
                    ...(current.verificationPayload as Prisma.JsonObject),
                    ...(outcome.facts as Prisma.InputJsonObject),
                },
                ...(opts.decidedById ? { decidedById: opts.decidedById } : {}),
                ...(opts.note !== undefined ? { note: opts.note } : {}),
            },
        });
        if (count === 0) return null;
        const row = (await tx.dealInvoice.findUnique({ where: { id: invoiceId } }))!;
        if (row.status === 'verified') {
            await this.events.record(tx, await this.event(tx, 'invoice.verified', row, actor));
            // A deal already Won with no amount takes what its verified invoices add up to; an open one does when
            // the `invoice.verified` rule closes it (`StageRulesService`).
            await fillWonDealAmount(tx, this.events, row.opportunityId, actor);
        }
        if (row.status === 'needs_review') await notifyReviewers(tx, workspaceId, row.id);
        return row;
    }

    private async event(
        tx: WorkspaceClient,
        type: 'invoice.verified' | 'invoice.invalidated' | 'invoice.refunded',
        row: Row,
        actor: Actor,
    ): Promise<DomainEvent> {
        const covered = await coverage(tx, row.opportunityId);
        const target = { type: 'opportunity' as const, id: row.opportunityId };
        return {
            type,
            object: 'invoice',
            workspaceId: row.workspaceId,
            actor,
            occurredAt: new Date().toISOString(),
            recordId: row.id,
            targets: [target],
            ...(type === 'invoice.verified' && covered ? { related: [target] } : {}),
            invoice: {
                opportunityId: row.opportunityId,
                gateway: row.gateway,
                reference: row.reference,
                amountMinor: row.amountMinor.toString(),
                refundedAmountMinor: row.refundedAmountMinor.toString(),
                currency: row.currency,
                status: row.status,
                reasonCode: row.reasonCode,
                covers: covered,
            },
        };
    }

    private current(): WorkspaceRunContext {
        const context = this.context.get();
        if (!context) throw new Error('InvoicesService is used inside a workspace scope');
        return context;
    }
}

/** The deal, if the caller can see it (live, in their owner scope); `404` otherwise. */
async function dealFor(tx: WorkspaceClient, context: WorkspaceRunContext, opportunityId: string) {
    const deal = await tx.opportunity.findFirst({
        where: { id: opportunityId, ...recordWhere(context, false) },
        select: { id: true, amountMinor: true, currency: true },
    });
    if (!deal) throw new NotFoundException('no such deal');
    return deal;
}

async function invoiceOn(tx: WorkspaceClient, opportunityId: string, invoiceId: string): Promise<Row> {
    const row = await tx.dealInvoice.findFirst({ where: { id: invoiceId, opportunityId } });
    if (!row) throw new NotFoundException('no such invoice on this deal');
    return row;
}

/**
 * Who the deal's client is, for NewswireOS (newswireos#647): the point of contact's addresses, then the company's
 * people's, at most `NEWSWIREOS_CLIENT_EMAILS_MAX`; and the company's domain unless it is free mail.
 */
async function clientOf(
    tx: WorkspaceClient,
    opportunityId: string,
): Promise<{ emails: string[]; domain: string | null }> {
    const deal = await tx.opportunity.findUnique({
        where: { id: opportunityId },
        select: {
            pointOfContact: { select: { emails: true, deletedAt: true } },
            company: { select: { id: true, domain: true } },
        },
    });
    if (!deal) return { emails: [], domain: null };
    const people = deal.company
        ? await tx.person.findMany({
              where: { companyId: deal.company.id, deletedAt: null },
              select: { emails: true },
              orderBy: { createdAt: 'asc' },
              take: NEWSWIREOS_CLIENT_EMAILS_MAX,
          })
        : [];
    const contact = deal.pointOfContact && !deal.pointOfContact.deletedAt ? [deal.pointOfContact] : [];
    const emails = new Set<string>();
    for (const p of [...contact, ...people]) {
        for (const e of addressesOf(p.emails)) {
            if (emails.size < NEWSWIREOS_CLIENT_EMAILS_MAX) emails.add(e);
        }
    }
    const domain = deal.company?.domain?.trim().toLowerCase() || null;
    return { emails: [...emails], domain: domain && !isFreeMailDomain(domain) ? domain : null };
}

/** A person's `emails` column (`{ primary, additional }`), as lower-cased addresses. */
function addressesOf(value: unknown): string[] {
    const o = value && typeof value === 'object' ? (value as { primary?: unknown; additional?: unknown }) : {};
    const all = [o.primary, ...(Array.isArray(o.additional) ? o.additional : [])];
    return all.filter((e): e is string => typeof e === 'string' && e.includes('@')).map((e) => e.trim().toLowerCase());
}

/** Whether the deal's verified invoices, net of refunds, cover its amount. */
async function coverage(tx: WorkspaceClient, opportunityId: string): Promise<boolean> {
    const deal = await tx.opportunity.findUnique({
        where: { id: opportunityId },
        select: { amountMinor: true, currency: true },
    });
    if (!deal) return false;
    const verified = await tx.dealInvoice.findMany({
        where: { opportunityId, status: 'verified' },
        select: { amountMinor: true, refundedAmountMinor: true, currency: true },
    });
    return covers(deal, verified);
}

/**
 * Tells whoever may verify invoices by hand — members whose role has `invoice:verify`, and admins — that one waits
 * for finance. Once per invoice per member; waiting again makes it unread again.
 */
async function notifyReviewers(
    tx: WorkspaceClient,
    workspaceId: string,
    invoiceId: string,
    kind: 'invoice_needs_review' | 'invoice_coverage_lost' = 'invoice_needs_review',
): Promise<void> {
    const reviewers = await invoiceReviewers(tx);
    if (reviewers.length === 0) return;
    await tx.notification.createMany({
        data: reviewers.map((memberId) => ({
            workspaceId,
            memberId,
            kind,
            invoiceId,
        })),
        skipDuplicates: true,
    });
    await tx.notification.updateMany({
        where: { invoiceId, kind, readAt: { not: null } },
        data: { readAt: null },
    });
}

/** Whoever may verify invoices by hand: members whose role has `invoice:verify`, and admins. */
export async function invoiceReviewers(tx: WorkspaceClient): Promise<string[]> {
    const reviewers = await tx.workspaceMember.findMany({
        where: {
            leftAt: null,
            role: {
                OR: [{ isSystem: true, name: 'admin' }, { permissions: { some: { capability: 'invoice:verify' } } }],
            },
        },
        select: { id: true },
    });
    return reviewers.map((m) => m.id);
}

export function view(row: Row): DealInvoiceView {
    return {
        id: row.id,
        opportunityId: row.opportunityId,
        gateway: row.gateway,
        reference: row.reference,
        canonicalReference: row.canonicalReference,
        resolvedGateway: row.resolvedGateway,
        amountMinor: row.amountMinor.toString(),
        refundedAmountMinor: row.refundedAmountMinor.toString(),
        currency: row.currency,
        attachmentId: row.attachmentId,
        status: row.status,
        reasonCode: row.reasonCode,
        note: row.note,
        verifiedAt: row.verifiedAt?.toISOString() ?? null,
        invalidatedAt: row.invalidatedAt?.toISOString() ?? null,
        createdById: row.createdById,
        decidedById: row.decidedById,
        createdAt: row.createdAt.toISOString(),
    };
}

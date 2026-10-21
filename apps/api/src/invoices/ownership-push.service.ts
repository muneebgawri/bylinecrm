import { randomUUID } from 'node:crypto';
import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { Queue } from 'bullmq';
import type { RecordTarget } from '@bylinecrm/shared';
import type { DeliveredEvent } from '../events/outbox-consumer';
import { ApiException } from '../infra/errors/api-errors';
import { PrismaService } from '../infra/prisma.service';
import { RlsPrismaService, type WorkspaceClient } from '../infra/rls-prisma.service';
import { SecretBox } from '../infra/secret-box';
import { WorkspaceContext } from '../infra/workspace-context';
import { TRANSFER_REASON_IMPORT_FILL } from '../transfers/transfers.service';
import {
    NEWSWIREOS_OWNERSHIP_EMAILS_MAX,
    OWNERSHIP_DELIVERIES_SHOWN,
    OWNERSHIP_PUSH_FINAL_CODES,
    OWNERSHIP_PUSH_JOB,
    OWNERSHIP_PUSH_QUEUE,
    OWNERSHIP_PUSH_REASONS,
    OWNERSHIP_PUSH_STUCK_MS,
    OWNERSHIP_PUSH_SWEEP_MAX,
} from './invoices.constants';
import { NewswireosApiError } from './newswireos-verification.port';
import {
    NEWSWIREOS_OWNERSHIP_PORT,
    type NewswireosOwnershipPort,
    type OwnershipChangedBody,
} from './ownership-push.port';
import type { OwnershipDeliveryView, OwnershipPushPreview } from './responses';

export interface OwnershipPushJob {
    workspaceId: string;
    deliveryId: string;
}

type DeliveryRow = Prisma.NewswireosOwnershipDeliveryGetPayload<object>;

/** Every address a person row holds, lower-cased: the primary first. */
function personEmails(emails: unknown): string[] {
    const o = emails && typeof emails === 'object' ? (emails as { primary?: unknown; additional?: unknown }) : {};
    const additional = Array.isArray(o.additional) ? o.additional : [];
    return [o.primary, ...additional]
        .map((e) => (typeof e === 'string' ? e : (e as { email?: unknown } | null)?.email))
        .filter((e): e is string => typeof e === 'string' && e.includes('@'))
        .map((e) => e.trim().toLowerCase());
}

/**
 * PNW-765: completed ownership transfers pushed to NewswireOS, so its account managers follow the CRM's owners.
 *
 * - **Outbox-driven.** The `newswireos-ownership` consumer hands every `transfer.completed` here; an import's owner
 *   fill (`internal`, reason `import_fill`) is not a move NewswireOS mirrors and never arrives.
 * - **Off by default.** Nothing is written or sent unless the workspace is linked and an admin turned the push on;
 *   a delivery queued before it was turned off is `skipped`, not sent.
 * - **One delivery per event**, keyed on the event's outbox id, which is also the push's `event_id`: a redelivered
 *   event writes nothing new, and NewswireOS dedupes a retried push.
 * - **Retry.** No answer, a 5xx or a 429 is retried by the queue's backoff; any other 4xx is final. A 404 (the route
 *   is not deployed yet) is `not_ready` and never retried.
 */
@Injectable()
export class OwnershipPushService {
    constructor(
        private readonly rls: RlsPrismaService,
        private readonly ownerPrisma: PrismaService,
        private readonly context: WorkspaceContext,
        private readonly secrets: SecretBox,
        @Inject(NEWSWIREOS_OWNERSHIP_PORT) private readonly newswireos: NewswireosOwnershipPort,
        @InjectQueue(OWNERSHIP_PUSH_QUEUE) private readonly queue: Queue<OwnershipPushJob>,
    ) {}

    /** Whether an event is one this push reads: a completed transfer an integration mirrors. */
    static accepts(event: DeliveredEvent['event']): boolean {
        return (
            event.type === 'transfer.completed' &&
            event.internal !== true &&
            event.transfer !== undefined &&
            event.transfer.reason !== TRANSFER_REASON_IMPORT_FILL
        );
    }

    /** The consumer's half: a delivery row and its job, when the push is on and the record has addresses. */
    async enqueueForEvent(delivered: DeliveredEvent): Promise<void> {
        if (!OwnershipPushService.accepts(delivered.event)) return;
        const workspaceId = delivered.event.workspaceId;
        const row = await this.rls.withWorkspace(workspaceId, async (tx) => {
            const link = await tx.newswireosSettings.findFirst({ select: { pushOwnership: true } });
            if (!link?.pushOwnership) return null;
            const existing = await tx.newswireosOwnershipDelivery.findUnique({
                where: { workspaceId_eventId: { workspaceId, eventId: delivered.id } },
            });
            if (existing) return existing;
            const body = await bodyFor(tx, delivered);
            if (!body) return null;
            return tx.newswireosOwnershipDelivery.create({
                data: {
                    workspaceId,
                    eventId: delivered.id,
                    transferId: delivered.event.recordId,
                    recordType: body.record_type,
                    recordId: body.record.byline_id,
                    payload: body as unknown as Prisma.InputJsonValue,
                },
            });
        });
        if (row && (row.status === 'pending' || row.status === 'retrying')) {
            // Redis down throws to the relay, which retries; the row is keyed on the event, so nothing doubles.
            await this.queue.add(OWNERSHIP_PUSH_JOB, { workspaceId, deliveryId: row.id }, { jobId: row.id });
        }
    }

    /**
     * Sends one delivery (the worker's half). `retry`: NewswireOS did not answer or failed on its side, and this is
     * not the last attempt; the caller throws so the queue tries again.
     */
    async deliver(workspaceId: string, deliveryId: string, opts: { finalAttempt: boolean }): Promise<'done' | 'retry'> {
        const { row, link } = await this.rls.withWorkspace(workspaceId, async (tx) => ({
            row: await tx.newswireosOwnershipDelivery.findUnique({ where: { id: deliveryId } }),
            link: await tx.newswireosSettings.findFirst({
                select: { baseUrl: true, apiTokenCiphertext: true, pushOwnership: true },
            }),
        }));
        if (!row || (row.status !== 'pending' && row.status !== 'retrying')) return 'done';
        const settle = (data: Prisma.NewswireosOwnershipDeliveryUpdateInput) =>
            this.rls.withWorkspace(workspaceId, (tx) =>
                tx.newswireosOwnershipDelivery.update({ where: { id: deliveryId }, data }),
            );
        if (!link?.pushOwnership) {
            await settle({ status: 'skipped', reasonCode: OWNERSHIP_PUSH_REASONS.pushOff });
            return 'done';
        }
        const attempt = { attempts: { increment: 1 }, lastAttemptAt: new Date() };
        try {
            const answer = await this.newswireos.push(
                { baseUrl: link.baseUrl, apiToken: this.secrets.open(link.apiTokenCiphertext) },
                row.payload as unknown as OwnershipChangedBody,
            );
            await settle({
                ...attempt,
                status: 'delivered',
                httpStatus: 200,
                matched: answer.matched,
                customers: answer.customers as unknown as Prisma.InputJsonValue,
                reasonCode: answer.reasonCode,
                lastError: null,
            });
            return 'done';
        } catch (error) {
            const e =
                error instanceof NewswireosApiError
                    ? error
                    : new NewswireosApiError(null, error instanceof Error ? error.message : String(error));
            const failed = { ...attempt, httpStatus: e.status, lastError: e.message.slice(0, 500) };
            if (e.reasonCode && OWNERSHIP_PUSH_FINAL_CODES.has(e.reasonCode)) {
                // NewswireOS has decided (an older change than one it applied; no account manager for the email).
                await settle({ ...failed, status: 'failed', reasonCode: e.reasonCode });
                return 'done';
            }
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
     * Queues again every delivery stuck `pending` past `OWNERSHIP_PUSH_STUCK_MS` whose job is gone (Redis lost it, or
     * the process died between the row and its job). Across workspaces, through the owner client. Idempotent: the
     * job id is the delivery, and a delivery is one per event, so a delivery whose job still exists is left alone and
     * a second pass adds nothing. Returns how many were queued.
     */
    async sweep(now = Date.now()): Promise<number> {
        const stuck = await this.ownerPrisma.newswireosOwnershipDelivery.findMany({
            where: { status: 'pending', createdAt: { lt: new Date(now - OWNERSHIP_PUSH_STUCK_MS) } },
            select: { id: true, workspaceId: true },
            orderBy: { createdAt: 'asc' },
            take: OWNERSHIP_PUSH_SWEEP_MAX,
        });
        let requeued = 0;
        for (const row of stuck) {
            if (await this.queue.getJob(row.id)) continue;
            await this.queue.add(
                OWNERSHIP_PUSH_JOB,
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
            await tx.newswireosSettings.update({ where: { id: existing.id }, data: { pushOwnership: enabled } });
        });
    }

    /** The latest deliveries, newest first. */
    deliveries(): Promise<OwnershipDeliveryView[]> {
        return this.rls.withWorkspace(async (tx) =>
            (
                await tx.newswireosOwnershipDelivery.findMany({
                    orderBy: { createdAt: 'desc' },
                    take: OWNERSHIP_DELIVERIES_SHOWN,
                })
            ).map(deliveryView),
        );
    }

    /**
     * A dry run: the body a push sends, for a made-up person handed to the caller. NewswireOS's route reads no
     * `test` flag (it would apply the change), so nothing is sent: the admin sees what would be.
     */
    async preview(): Promise<OwnershipPushPreview> {
        const context = this.context.get()!;
        const email = await this.rls.withWorkspace(async (tx) =>
            context.memberId
                ? (
                      await tx.workspaceMember.findUnique({
                          where: { id: context.memberId },
                          select: { user: { select: { email: true } } },
                      })
                  )?.user.email
                : undefined,
        );
        const payload: OwnershipChangedBody = {
            event_id: randomUUID(),
            occurred_at: new Date().toISOString(),
            record_type: 'person',
            record: {
                byline_id: randomUUID(),
                emails: ['jane.doe@example.com'],
                domain: 'example.com',
                name: 'Jane Doe',
            },
            previous_owner: null,
            new_owner: { email: email ?? 'owner@example.com' },
            reason: 'transfer',
            forced: false,
        };
        return { sent: false, payload: { ...payload, test: true } };
    }
}

/**
 * The body for a completed transfer: the record that changed hands (a deal's company, or its person), with every
 * address NewswireOS may match on. Null when there is nothing to match: no person or company, or no address.
 */
async function bodyFor(tx: WorkspaceClient, delivered: DeliveredEvent): Promise<OwnershipChangedBody | null> {
    const t = delivered.event.transfer!;
    const head: RecordTarget | undefined =
        t.object === 'person' || t.object === 'company'
            ? { type: t.object, id: t.recordId }
            : (t.moved.find((m) => m.type === 'company') ?? t.moved.find((m) => m.type === 'person'));
    if (!head) return null;

    let record: OwnershipChangedBody['record'];
    if (head.type === 'person') {
        const person = await tx.person.findUnique({
            where: { id: head.id },
            select: { nameFirst: true, nameLast: true, emails: true, company: { select: { domain: true } } },
        });
        if (!person) return null;
        const emails = [...new Set(personEmails(person.emails))];
        record = {
            byline_id: head.id,
            emails,
            ...(person.company?.domain ? { domain: person.company.domain } : {}),
            ...(name(`${person.nameFirst} ${person.nameLast}`)
                ? { name: name(`${person.nameFirst} ${person.nameLast}`)! }
                : {}),
        };
    } else {
        const company = await tx.company.findUnique({ where: { id: head.id }, select: { name: true, domain: true } });
        if (!company) return null;
        const people = await tx.person.findMany({
            where: { companyId: head.id, deletedAt: null, emailPrimary: { not: null } },
            select: { emailPrimary: true },
            orderBy: { createdAt: 'asc' },
            take: NEWSWIREOS_OWNERSHIP_EMAILS_MAX,
        });
        const emails = [
            ...new Set([...t.identity.personEmails, ...people.map((p) => p.emailPrimary!)].map((e) => e.toLowerCase())),
        ];
        record = {
            byline_id: head.id,
            emails,
            ...(company.domain ? { domain: company.domain } : {}),
            ...(name(company.name) ? { name: name(company.name)! } : {}),
        };
    }
    record.emails = record.emails.slice(0, NEWSWIREOS_OWNERSHIP_EMAILS_MAX);
    if (record.emails.length === 0) return null;

    // NewswireOS orders changes to one record by `occurred_at`: the transfer's own completion time, never this
    // delivery's (a retried or redelivered push must not overtake a later change).
    const transfer = await tx.ownershipTransfer.findUnique({
        where: { id: delivered.event.recordId },
        select: { decidedAt: true },
    });

    const members = await tx.workspaceMember.findMany({
        where: { id: { in: [t.toMemberId, ...(t.fromMemberId ? [t.fromMemberId] : [])] } },
        select: { id: true, user: { select: { email: true } } },
    });
    const emailOf = (id: string) => members.find((m) => m.id === id)?.user.email;
    const to = emailOf(t.toMemberId);
    if (!to) return null;
    const from = t.fromMemberId && t.fromMemberId !== t.toMemberId ? emailOf(t.fromMemberId) : undefined;
    const firstContact = t.firstContact === true;
    return {
        event_id: delivered.id,
        occurred_at: transfer?.decidedAt?.toISOString() ?? delivered.event.occurredAt,
        record_type: head.type as 'person' | 'company',
        record,
        previous_owner: from ? { email: from } : null,
        new_owner: { email: to },
        reason: firstContact ? 'first_contact' : t.status === 'accepted' ? 'transfer' : 'forced',
        forced: !firstContact && t.status === 'forced',
    };
}

function name(value: string): string | undefined {
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
}

function deliveryView(row: DeliveryRow): OwnershipDeliveryView {
    const body = row.payload as unknown as Partial<OwnershipChangedBody>;
    return {
        id: row.id,
        eventId: row.eventId,
        transferId: row.transferId,
        recordType: row.recordType as 'person' | 'company',
        recordId: row.recordId,
        recordName: body.record?.name ?? '',
        newOwnerEmail: body.new_owner?.email ?? '',
        reason: body.reason ?? 'transfer',
        status: row.status as OwnershipDeliveryView['status'],
        attempts: row.attempts,
        matched: row.matched,
        customers: Array.isArray(row.customers) ? (row.customers as unknown as OwnershipDeliveryView['customers']) : [],
        reasonCode: row.reasonCode,
        httpStatus: row.httpStatus,
        lastError: row.lastError,
        lastAttemptAt: row.lastAttemptAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
    };
}

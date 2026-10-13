import { Injectable, NotFoundException } from '@nestjs/common';
import type { Suppression } from '@prisma/client';
import {
    isLiftable,
    normaliseEmail,
    type Actor,
    type DomainEvent,
    type SuppressionReason,
    type SuppressionSource,
} from '@bylinecrm/shared';
import { DomainEvents } from '../events/domain-events.service';
import { ApiException, StateConflict, UniqueConflict, ValidationFailed } from '../infra/errors/api-errors';
import { uniqueViolation } from '../infra/prisma-errors';
import { personsByAddress } from '../mail-sync/matching';
import { RlsPrismaService, type WorkspaceClient } from '../infra/rls-prisma.service';
import { WorkspaceContext, type WorkspaceRunContext } from '../infra/workspace-context';
import { actorOf } from '../records/actor';
import { paginate, type Page } from '../records/list-query';
import type { ListSuppressionsQuery } from './dto';
import type { SuppressionView } from './responses';

/** What puts an address on the list, from any caller: a member, the unsubscribe link, a bounce report (P3-2). */
export interface SuppressInput {
    address: string;
    reason: SuppressionReason;
    source: SuppressionSource;
    personId?: string | null | undefined;
    outboundId?: string | null | undefined;
    note?: string | null | undefined;
}

/** A live entry, as a check reports it. */
export interface SuppressedAddress {
    id: string;
    reason: SuppressionReason;
}

/**
 * The suppression list (P3-1, FR-CRMS-7): addresses the workspace never mails.
 *
 * `check` is the one read a decision is made from — `SendPolicy` on every send, and P3-3's enrolment.
 * `suppress` is the one write that puts an address on the list, whoever asks: a member (`add`), the
 * unsubscribe link (`UnsubscribeService`), a provider's bounce or complaint report (P3-2). It is
 * idempotent: an address already suppressed keeps its entry. Lifting (`remove`) keeps the row and
 * records who, when and why; an unsubscribe or a complaint is never lifted.
 */
@Injectable()
export class SuppressionService {
    constructor(
        private readonly rls: RlsPrismaService,
        private readonly context: WorkspaceContext,
        private readonly events: DomainEvents,
    ) {}

    /** The live entries among these addresses (compared lower case), keyed by address. */
    async check(workspaceId: string, addresses: readonly string[]): Promise<Map<string, SuppressedAddress>> {
        const wanted = [...new Set(addresses.map((a) => a.trim().toLowerCase()))];
        if (wanted.length === 0) return new Map();
        const rows = await this.rls.withWorkspace(workspaceId, (tx) =>
            tx.suppression.findMany({
                where: { address: { in: wanted }, removedAt: null },
                select: { id: true, address: true, reason: true },
            }),
        );
        return new Map(rows.map((r) => [r.address, { id: r.id, reason: r.reason }]));
    }

    /**
     * Puts an address on the list in this workspace, or finds it already there. Returns the live
     * entry; records `suppression.added` only when it wrote one.
     */
    async suppress(workspaceId: string, input: SuppressInput, actor: Actor = SYSTEM): Promise<SuppressionView> {
        const address = normaliseEmail(input.address);
        if (!address)
            throw new ValidationFailed('not an email address', [{ path: 'address', message: 'not an email address' }]);
        const { row } = await this.writeOnce(workspaceId, address, input, actor);
        return view(row);
    }

    // ── Members' routes ─────────────────────────────────────────────────────────────────────

    list(query: ListSuppressionsQuery): Promise<Page<SuppressionView>> {
        this.current();
        return this.rls.withWorkspace(async (tx) => {
            const page = await paginate(query.limit, query.cursor, (args) =>
                tx.suppression.findMany({
                    where: {
                        removedAt: null,
                        ...(query.reason ? { reason: query.reason } : {}),
                        ...(query.q ? { address: { contains: query.q.toLowerCase() } } : {}),
                    },
                    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
                    ...args,
                }),
            );
            return { items: page.items.map(view), nextCursor: page.nextCursor };
        });
    }

    /** A member suppresses an address by hand: reason `manual`. An address already live is a conflict. */
    async add(input: { address: string; note?: string | undefined }): Promise<SuppressionView> {
        const context = this.current();
        const address = normaliseEmail(input.address);
        if (!address) {
            throw new ValidationFailed('not an email address', [
                { path: 'address', message: 'enter an address like someone@example.com' },
            ]);
        }
        const actor = actorOf(context);
        const { row, created } = await this.writeOnce(
            context.workspaceId,
            address,
            { address, reason: 'manual', source: 'member', note: input.note || null },
            actor,
            context.memberId ?? null,
        );
        if (!created) throw new UniqueConflict('this address is already suppressed', 'address');
        return view(row);
    }

    /** Lifts a hard bounce or a manual entry; the row stays, with who lifted it, when and why. */
    async remove(id: string, note: string): Promise<void> {
        const context = this.current();
        await this.rls.withWorkspace(async (tx) => {
            const row = await tx.suppression.findFirst({ where: { id, removedAt: null } });
            if (!row) throw new NotFoundException('suppression not found');
            if (!isLiftable(row.reason)) {
                throw new StateConflict(
                    row.reason === 'unsubscribe'
                        ? 'the person unsubscribed; only they can undo it'
                        : 'the person reported spam; only they can undo it',
                );
            }
            const lifted = await tx.suppression.update({
                where: { id },
                data: { removedAt: new Date(), removedByMemberId: context.memberId ?? null, removalNote: note },
            });
            await this.events.record(
                tx,
                suppressionEvent('suppression.removed', context.workspaceId, actorOf(context), lifted),
            );
        });
    }

    // ── Internals ────────────────────────────────────────────────────────────────────────────

    /**
     * Inserts the live entry, or reads the one already there. A permanent reason (an unsubscribe, a
     * complaint) arriving for an address held only by a liftable entry supersedes it — the old entry is
     * lifted with a note and the new one written — so lifting a bounce can never undo a person's own
     * choice. Two writers racing on the same address meet at the partial unique index; the loser reads
     * the winner's row in a new transaction.
     */
    private async writeOnce(
        workspaceId: string,
        address: string,
        input: SuppressInput,
        actor: Actor,
        createdByMemberId: string | null = actor.kind === 'member' ? actor.id : null,
    ): Promise<{ row: Suppression; created: boolean; superseded: Suppression | null }> {
        const live = (tx: WorkspaceClient) => tx.suppression.findFirst({ where: { address, removedAt: null } });
        try {
            return await this.rls.withWorkspace(workspaceId, async (tx) => {
                const existing = await live(tx);
                const supersedes = existing !== null && isLiftable(existing.reason) && !isLiftable(input.reason);
                if (existing && !supersedes) return { row: existing, created: false, superseded: null };
                const superseded = existing
                    ? await tx.suppression.update({
                          where: { id: existing.id },
                          data: { removedAt: new Date(), removalNote: SUPERSEDED_NOTE[input.reason] },
                      })
                    : null;
                // Whose address it is, when the caller didn't say (a member's manual entry): the same
                // rule synced mail uses (PAR-028), so the entry and its timeline line land on that person.
                const personId = input.personId ?? (await personsByAddress(tx, [address])).get(address) ?? null;
                const row = await tx.suppression.create({
                    data: {
                        workspaceId,
                        address,
                        reason: input.reason,
                        source: input.source,
                        personId,
                        outboundId: input.outboundId ?? null,
                        note: input.note ?? null,
                        createdByMemberId,
                    },
                });
                // Recorded in the transaction that wrote them (P1-6): they exist exactly when the change does.
                await this.events.recordAll(tx, [
                    ...(superseded ? [suppressionEvent('suppression.removed', workspaceId, actor, superseded)] : []),
                    suppressionEvent('suppression.added', workspaceId, actor, row),
                ]);
                return { row, created: true, superseded };
            });
        } catch (error) {
            if (!uniqueViolation(error)) throw error;
            const won = await this.rls.withWorkspace(workspaceId, live);
            if (!won) throw error;
            return { row: won, created: false, superseded: null };
        }
    }

    private current(): WorkspaceRunContext {
        const context = this.context.get();
        if (!context) throw new Error('SuppressionService is used inside a workspace scope');
        return context;
    }
}

const SYSTEM: Actor = { kind: 'system', id: null };

/** The note a liftable entry is lifted with when the person's own choice replaces it. */
const SUPERSEDED_NOTE: Readonly<Record<SuppressionReason, string>> = {
    unsubscribe: 'replaced by the person unsubscribing',
    complaint: 'replaced by the person reporting spam',
    hard_bounce: 'replaced by a hard bounce',
    manual: 'replaced by a manual entry',
};

/** The event an entry's write records: `suppression.added` or `suppression.removed`. */
function suppressionEvent(
    type: 'suppression.added' | 'suppression.removed',
    workspaceId: string,
    actor: Actor,
    row: Suppression,
): DomainEvent {
    return {
        type,
        object: 'suppression',
        workspaceId,
        actor,
        occurredAt: new Date().toISOString(),
        recordId: row.id,
        suppression: {
            address: row.address,
            reason: row.reason,
            source: row.source,
            personId: row.personId,
            note: type === 'suppression.added' ? row.note : row.removalNote,
        },
        // The person the address belongs to: what the event concerns, and where its timeline entry goes (#114).
        ...(row.personId
            ? { related: [{ type: 'person', id: row.personId }], targets: [{ type: 'person', id: row.personId }] }
            : {}),
    } as DomainEvent;
}

/** A refusal for recipients on the list — see `SendPolicy`. Exported for the policy's one use. */
export class RecipientSuppressed extends ApiException {
    constructor(fieldErrors: readonly { path: string; message: string }[]) {
        super(422, 'recipient.suppressed', 'a recipient is on the suppression list; nothing was sent', fieldErrors);
    }
}

export function view(row: Suppression): SuppressionView {
    return {
        id: row.id,
        address: row.address,
        reason: row.reason,
        source: row.source,
        personId: row.personId,
        note: row.note,
        createdByMemberId: row.createdByMemberId,
        createdAt: row.createdAt,
        liftable: isLiftable(row.reason),
    };
}

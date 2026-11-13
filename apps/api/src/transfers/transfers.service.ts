import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type {
    DomainEvent,
    Emails,
    LabelledTarget,
    NotificationKind,
    OwnershipSettingsView,
    RecordObject,
    RecordTarget,
    TransferEventPayload,
    TransferMember,
    TransferPreviewView,
    TransferStatus,
    TransferView,
} from '@bylinecrm/shared';
import { TRANSFER_PREVIEW_NAMES, TRANSFER_REASON_RELEASED } from '@bylinecrm/shared';
import type { Prisma } from '@prisma/client';
import { DomainEvents } from '../events/domain-events.service';
import { requireCallerMember } from '../infra/caller-member';
import { ApiException, UnknownReference } from '../infra/errors/api-errors';
import { uniqueViolation } from '../infra/prisma-errors';
import { RlsPrismaService, type WorkspaceClient } from '../infra/rls-prisma.service';
import { WorkspaceContext, type WorkspaceRunContext } from '../infra/workspace-context';
import { labelled, labelTargets } from '../notifications/task-labels';
import { actorOf } from '../records/actor';
import { recordWhere } from '../records/record-scope';
import { MEMBER_SUMMARY_SELECT } from '../records/summaries';
import { dormantOwnerMonths } from '../records/company-ownership';
import { assertNotCooling, coolingDays } from './transfer-cooling';

/** The reason on a hand-over that gave an owner to a record that had none, from an import's source (Bigin). */
export const TRANSFER_REASON_IMPORT_FILL = 'import_fill';

const MEMBER = { select: MEMBER_SUMMARY_SELECT } as const;
const INCLUDE = { from: MEMBER, to: MEMBER, proposedBy: MEMBER, decidedBy: MEMBER } as const;
type Row = Prisma.OwnershipTransferGetPayload<{ include: typeof INCLUDE }>;

/** The record a transfer is about, as the service needs it: its owner, and the company it belongs to. */
interface Head {
    id: string;
    ownerId: string | null;
    companyId: string | null;
}

/**
 * Ownership transfers (OWN-1, FR-CRMS-17): the one way a record changes hands.
 *
 * - **Propose.** The record's owner offers it to another member (`record:write`); the receiver is told
 *   and accepts or declines. One open proposal per record.
 * - **Force.** A holder of `record:transfer` — the `manager` system role, admins — moves a record at
 *   once; the transfer says so (`forced`), and both the old and the new owner are told.
 * - **The unit.** What moves is the record and what goes with it, so a lead and its deal never end up
 *   with different owners: a company moves with the people at it and its open deals that the old owner
 *   held; a person moves with their company's unit when the old owner held the company, else with the
 *   open deals they are the contact for; a deal moves alone.
 * - **Announced twice.** `transfer.completed` carries the unit and the identities a receiver matches on
 *   (NewswireOS keys its account managers by email and domain); each moved record also gets its own
 *   `…updated` with `diff.ownerId`, so a subscriber to record changes sees the move as any other edit.
 *
 * The move runs without the caller's owner scope: a receiver under an own-scoped role cannot see the
 * records they are about to receive, and the transfer is their permission to take them.
 */
@Injectable()
export class TransfersService {
    constructor(
        private readonly rls: RlsPrismaService,
        private readonly context: WorkspaceContext,
        private readonly events: DomainEvents,
    ) {}

    async propose(input: {
        object: RecordObject;
        recordId: string;
        toMemberId: string;
        reason?: string | undefined;
    }): Promise<TransferView> {
        const context = this.current();
        const canForce = context.capabilities.has('record:transfer');
        return this.rls.withWorkspace(async (tx) => {
            const me = await requireCallerMember(tx, context);
            const head = await findHead(tx, context, input.object, input.recordId);
            if (!head) throw new NotFoundException('record not found');
            if (!canForce && head.ownerId !== me) {
                throw new ForbiddenException('only the record’s owner may hand it on; a manager may move it');
            }
            const to = await tx.workspaceMember.findFirst({
                where: { id: input.toMemberId, leftAt: null },
                select: { id: true, user: { select: { displayName: true } } },
            });
            if (!to) throw new UnknownReference('toMemberId', 'not a member of this workspace');
            if (to.id === head.ownerId) throw new UnknownReference('toMemberId', 'already the owner');
            // The cooling period: a record does not go straight back to a member it just left. Managers are exempt.
            if (!canForce) {
                await assertNotCooling(tx, {
                    object: input.object,
                    recordId: input.recordId,
                    memberId: to.id,
                    memberName: to.user.displayName ?? 'that member',
                });
            }

            if (canForce) {
                const row = await this.complete(tx, context, {
                    create: {
                        object: input.object,
                        recordId: input.recordId,
                        fromMemberId: head.ownerId,
                        toMemberId: to.id,
                        proposedByMemberId: me,
                        decidedByMemberId: me,
                        status: 'forced',
                        reason: input.reason ?? null,
                    },
                    head,
                    me,
                    scope: wholeCompany(input.object),
                });
                return view(row, await labelsFor(tx, row));
            }

            let row: Row;
            try {
                row = await tx.ownershipTransfer.create({
                    data: {
                        workspaceId: context.workspaceId,
                        object: input.object,
                        recordId: input.recordId,
                        fromMemberId: head.ownerId,
                        toMemberId: to.id,
                        proposedByMemberId: me,
                        reason: input.reason ?? null,
                    },
                    include: INCLUDE,
                });
            } catch (error) {
                if (uniqueViolation(error))
                    throw new ConflictException('a transfer of this record is already proposed');
                throw error;
            }
            await tell(tx, row, to.id, 'transfer_proposed');
            await this.events.record(tx, event(context, 'transfer.proposed', row, []));
            return view(row, await labelsFor(tx, row));
        });
    }

    /**
     * The owner gives the record up. It goes to the workspace's house account (`releaseToMemberId`, Settings →
     * Ownership) at once, as a `forced` transfer the owner made: the unit an owner's hand-on moves, and the same
     * announcements. The house account is not asked and its bell is left alone — it is where released records wait
     * for a manager, not a member working them. `422` while no house account is set (or it has left).
     */
    async release(input: { object: RecordObject; recordId: string; note?: string | undefined }): Promise<TransferView> {
        const context = this.current();
        return this.rls.withWorkspace(async (tx) => {
            const me = await requireCallerMember(tx, context);
            const head = await findHead(tx, context, input.object, input.recordId);
            if (!head) throw new NotFoundException('record not found');
            if (head.ownerId !== me) throw new ForbiddenException('only the record’s owner may release it');
            const settings = await tx.ownershipSettings.findFirst({ select: { releaseToMemberId: true } });
            const to = settings?.releaseToMemberId
                ? await tx.workspaceMember.findFirst({
                      where: { id: settings.releaseToMemberId, leftAt: null },
                      select: { id: true },
                  })
                : null;
            if (!to) {
                throw new ApiException(
                    422,
                    'unprocessable',
                    'no account is set to receive released records: a manager sets one in Settings → Ownership',
                    [{ path: 'recordId', message: 'NO_RELEASE_ACCOUNT' }],
                );
            }
            if (to.id === me)
                throw new ConflictException('released records come to you: there is nobody to release to');
            const open = await tx.ownershipTransfer.findFirst({
                where: { object: input.object, recordId: input.recordId, status: 'proposed' },
                select: { id: true },
            });
            if (open) throw new ConflictException('this record is offered to someone: take the offer back first');
            const row = await this.complete(tx, context, {
                create: {
                    object: input.object,
                    recordId: input.recordId,
                    fromMemberId: me,
                    toMemberId: to.id,
                    proposedByMemberId: me,
                    decidedByMemberId: me,
                    status: 'forced',
                    reason: TRANSFER_REASON_RELEASED,
                    note: input.note ?? null,
                },
                head,
                me,
                silent: true,
            });
            return view(row, await labelsFor(tx, row));
        });
    }

    /**
     * OWN-1b: what a manager's move of the record to `toMemberId` would take, and from whom — the confirmation
     * before the move. Read past the caller's owner scope, as the move is.
     */
    async preview(input: { object: RecordObject; recordId: string; toMemberId: string }): Promise<TransferPreviewView> {
        const context = this.current();
        if (!context.capabilities.has('record:transfer')) {
            throw new ForbiddenException('only a manager moves a record at once');
        }
        return this.widened(context, async (tx) => {
            const head = await findHead(tx, widen(context), input.object, input.recordId);
            if (!head) throw new NotFoundException('record not found');
            const unit = await unitOf(
                tx,
                input.object,
                head,
                head.ownerId,
                wholeCompany(input.object),
                input.toMemberId,
            );
            return previewOf(tx, unit);
        });
    }

    async list(query: {
        object?: RecordObject | undefined;
        recordId?: string | undefined;
        status?: TransferStatus | undefined;
    }): Promise<TransferView[]> {
        const context = this.current();
        const seesAll = context.capabilities.has('record:transfer');
        return this.rls.withWorkspace(async (tx) => {
            const me = await requireCallerMember(tx, context);
            const rows = await tx.ownershipTransfer.findMany({
                where: {
                    ...(query.object ? { object: query.object } : {}),
                    ...(query.recordId ? { recordId: query.recordId } : {}),
                    ...(query.status ? { status: query.status } : {}),
                    ...(seesAll ? {} : { OR: [{ fromMemberId: me }, { toMemberId: me }, { proposedByMemberId: me }] }),
                },
                orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
                take: 200,
                include: INCLUDE,
            });
            const labels = await labelsFor(tx, ...rows);
            return rows.map((row) => view(row, labels));
        });
    }

    /** Settings → Ownership: the transfer cooling period and when a company's owner lets it go (OWN-2f). */
    settings(): Promise<OwnershipSettingsView> {
        return this.rls.withWorkspace(async (tx) => ({
            transferCoolingDays: await coolingDays(tx),
            dormantOwnerMonths: await dormantOwnerMonths(tx),
            releaseToMemberId:
                (await tx.ownershipSettings.findFirst({ select: { releaseToMemberId: true } }))?.releaseToMemberId ??
                null,
        }));
    }

    /** The two periods are replaced; `releaseToMemberId` changes only when named (null turns releasing off). */
    setSettings(
        input: Omit<OwnershipSettingsView, 'releaseToMemberId'> & { releaseToMemberId?: string | null | undefined },
    ): Promise<OwnershipSettingsView> {
        const workspaceId = this.current().workspaceId;
        const data = {
            transferCoolingDays: input.transferCoolingDays,
            dormantOwnerMonths: input.dormantOwnerMonths,
            ...(input.releaseToMemberId !== undefined ? { releaseToMemberId: input.releaseToMemberId } : {}),
        };
        return this.rls.withWorkspace(async (tx) => {
            if (input.releaseToMemberId) {
                const member = await tx.workspaceMember.findFirst({
                    where: { id: input.releaseToMemberId, leftAt: null },
                    select: { id: true },
                });
                if (!member) throw new UnknownReference('releaseToMemberId', 'not a member of this workspace');
            }
            const row = await tx.ownershipSettings.upsert({
                where: { workspaceId },
                create: { workspaceId, ...data },
                update: data,
            });
            return {
                transferCoolingDays: row.transferCoolingDays,
                dormantOwnerMonths: row.dormantOwnerMonths,
                releaseToMemberId: row.releaseToMemberId,
            };
        });
    }

    /** The receiver takes the record and its unit. */
    async accept(id: string): Promise<TransferView> {
        const context = this.current();
        return this.rls.withWorkspace(async (tx) => {
            const me = await requireCallerMember(tx, context);
            const open = await openTransfer(tx, id);
            if (open.toMemberId !== me) throw new ForbiddenException('only the member it is offered to may accept');
            if (!context.capabilities.has('record:transfer')) {
                await assertNotCooling(tx, {
                    object: open.object as RecordObject,
                    recordId: open.recordId,
                    memberId: me,
                    memberName: null,
                });
            }
            const head = await this.widened(context, (wide) =>
                findHead(wide, widen(context), open.object, open.recordId),
            );
            if (!head) throw new ConflictException('the record is gone');
            if (head.ownerId !== open.fromMemberId) {
                throw new ConflictException('the record changed owner since this was proposed');
            }
            const row = await this.complete(tx, context, { update: open, head, me });
            return view(row, await labelsFor(tx, row));
        });
    }

    async decline(id: string, note?: string): Promise<TransferView> {
        const context = this.current();
        return this.rls.withWorkspace(async (tx) => {
            const me = await requireCallerMember(tx, context);
            const open = await openTransfer(tx, id);
            if (open.toMemberId !== me) throw new ForbiddenException('only the member it is offered to may decline');
            const row = await tx.ownershipTransfer.update({
                where: { id },
                data: { status: 'declined', note: note ?? null, decidedByMemberId: me, decidedAt: new Date() },
                include: INCLUDE,
            });
            if (row.proposedByMemberId !== me) await tell(tx, row, row.proposedByMemberId, 'transfer_declined');
            await this.events.record(tx, event(context, 'transfer.declined', row, []));
            return view(row, await labelsFor(tx, row));
        });
    }

    /** The proposer takes the offer back; a manager may cancel any. */
    async cancel(id: string, note?: string): Promise<TransferView> {
        const context = this.current();
        return this.rls.withWorkspace(async (tx) => {
            const me = await requireCallerMember(tx, context);
            const open = await openTransfer(tx, id);
            if (open.proposedByMemberId !== me && !context.capabilities.has('record:transfer')) {
                throw new ForbiddenException('only who proposed it, or a manager, may cancel');
            }
            const row = await tx.ownershipTransfer.update({
                where: { id },
                data: { status: 'cancelled', note: note ?? null, decidedByMemberId: me, decidedAt: new Date() },
                include: INCLUDE,
            });
            await this.events.record(tx, event(context, 'transfer.cancelled', row, []));
            return view(row, await labelsFor(tx, row));
        });
    }

    /**
     * OWN-2: a record saved straight into another member's hands — a lead at a company they own, handed to
     * them by whoever found it. `create` writes the record (owned by `to`) in a transaction that is not held
     * to the saver's owner scope; the hand-over is recorded as a `forced` transfer from the saver, so the
     * owner is told (`transfer_received`) and integrations hear `transfer.completed` like any other move.
     */
    async handOver<R>(
        context: WorkspaceRunContext,
        from: string,
        to: string,
        create: (tx: WorkspaceClient, wide: WorkspaceRunContext) => Promise<{ row: R; target: RecordTarget }>,
        reason: string,
    ): Promise<R> {
        return this.widened(context, async (tx) => {
            const wide = widen(context);
            const { row, target } = await create(tx, wide);
            await this.recordHandOverIn(tx, wide, { from, to, target, reason, firstContact: true });
            return row;
        });
    }

    /**
     * The hand-over's record, in the caller's transaction: the record (already the receiver's) was saved
     * for them by `from` — a member, or a job acting for one (a calendar sync's lead at a company another
     * member owns). The receiver is told; `transfer.completed` is announced.
     *
     * `from` null: an owner given to a record that had none (an import filling it, `TRANSFER_REASON_IMPORT_FILL`);
     * the receiver proposed and decided it. `silent` (a fill) leaves the receiver's bell alone — a run filling
     * thousands of records says so in its report instead — and its `transfer.completed` is `internal`: on the
     * timeline, never sent to a webhook.
     */
    async recordHandOverIn(
        tx: WorkspaceClient,
        context: WorkspaceRunContext,
        input: {
            from: string | null;
            to: string;
            target: RecordTarget;
            reason: string;
            silent?: boolean;
            /** A first contact's hand-over (OWN-2): the event says so, for NewswireOS (PNW-765). */
            firstContact?: boolean;
        },
    ): Promise<void> {
        const transfer = await tx.ownershipTransfer.create({
            data: {
                workspaceId: context.workspaceId,
                object: input.target.type,
                recordId: input.target.id,
                fromMemberId: input.from,
                toMemberId: input.to,
                proposedByMemberId: input.from ?? input.to,
                decidedByMemberId: input.from ?? input.to,
                status: 'forced',
                reason: input.reason,
                decidedAt: new Date(),
                moved: [input.target] as object[],
            },
            include: INCLUDE,
        });
        const person =
            input.target.type === 'person'
                ? await tx.person.findUnique({ where: { id: input.target.id }, select: { emailPrimary: true } })
                : null;
        if (!input.silent) await tell(tx, transfer, input.to, 'transfer_received');
        const completed = event(context, 'transfer.completed', transfer, [input.target], {
            companyDomain: null,
            personEmails: person?.emailPrimary ? [person.emailPrimary] : [],
        });
        if (input.firstContact && completed.transfer) completed.transfer.firstContact = true;
        await this.events.record(tx, input.silent ? { ...completed, internal: true } : completed);
    }

    /**
     * CADENCE-1: the rotation's forced move of a lapsed lead from its owner to the next rep, for a job acting for the
     * workspace (no caller). It is any forced transfer: the unit moves, the old owner hears `transfer_taken`, the new
     * one `transfer_received`, and `transfer.completed` is announced (NewswireOS included). Proposed and decided by
     * the receiver, as an import's fill is; `reason` says it was the rotation and `note` says why. Unlike other
     * transfers it moves only the deal, plus its contact alone when `withContact` (never the contact's company or
     * other deals). Null when the deal is gone or no longer `from`'s.
     */
    async rotate(
        context: WorkspaceRunContext,
        input: {
            recordId: string;
            withContact?: string | undefined;
            from: string;
            to: string;
            reason: string;
            note: string;
        },
    ): Promise<TransferView | null> {
        return this.widened(context, async (tx) => {
            const wide = widen(context);
            const head = await findHead(tx, wide, 'opportunity', input.recordId);
            if (!head || head.ownerId !== input.from || input.from === input.to) return null;
            const unit = input.withContact
                ? await this.widened(context, (w) => contactAlone(w, input.withContact!, input.from))
                : null;
            const row = await this.complete(tx, wide, {
                create: {
                    object: 'opportunity',
                    recordId: input.recordId,
                    fromMemberId: input.from,
                    toMemberId: input.to,
                    proposedByMemberId: input.to,
                    decidedByMemberId: input.to,
                    status: 'forced',
                    reason: input.reason,
                    note: input.note,
                },
                head,
                me: input.to,
                unit: {
                    targets: [{ type: 'opportunity', id: head.id }, ...(unit ? [unit.target] : [])],
                    identity: { companyDomain: null, personEmails: unit?.email ? [unit.email] : [] },
                },
            });
            return view(row, await labelsFor(tx, row));
        });
    }

    /**
     * OWN-2d: a forced move of a person to their company's owner, for a job acting for the workspace (the
     * `assign-company-owners.js` backfill: the import left a company's people with different owners). It is any
     * forced transfer of a person — proposed and decided by the receiver, as an import's fill is — whose unit is
     * the person and the open deals they are the contact of (the company is the receiver's already, so it and its
     * other people stay put); `transfer.completed` and the records' `updated` events are written as for any move.
     * `silent` leaves the bells alone: a run moving thousands says so in its report. Null when the person is gone
     * or already the receiver's.
     */
    async reassign(
        context: WorkspaceRunContext,
        input: { personId: string; to: string; reason: string; silent?: boolean | undefined },
    ): Promise<TransferView | null> {
        return this.widened(context, async (tx) => {
            const wide = widen(context);
            const head = await findHead(tx, wide, 'person', input.personId);
            if (!head || head.ownerId === input.to) return null;
            const row = await this.complete(tx, wide, {
                create: {
                    object: 'person',
                    recordId: head.id,
                    fromMemberId: head.ownerId,
                    toMemberId: input.to,
                    proposedByMemberId: input.to,
                    decidedByMemberId: input.to,
                    status: 'forced',
                    reason: input.reason,
                },
                head,
                me: input.to,
                silent: input.silent,
            });
            return view(row, await labelsFor(tx, row));
        });
    }

    // ─────────────────────────────────────────────────────────────────────────────────────────

    /**
     * Moves the unit and writes the completed transfer: a forced one being created, or an accepted
     * proposal. The reads and writes of the records run without the caller's owner scope (see the class).
     */
    private async complete(
        tx: WorkspaceClient,
        context: WorkspaceRunContext,
        input: {
            create?: Omit<Prisma.OwnershipTransferUncheckedCreateInput, 'workspaceId' | 'decidedAt' | 'moved'>;
            update?: Row;
            head: Head;
            me: string;
            /** The records to move, when not the object's usual unit (the rotation's). */
            unit?: { targets: RecordTarget[]; identity: TransferEventPayload['identity'] };
            /** No bells (a backfill's move): the transfer, its events and the records' moves are written as ever. */
            silent?: boolean | undefined;
            /** OWN-1b: a manager's move takes the whole company (`unitOf`'s `company` scope). */
            scope?: 'owner' | 'company';
        },
    ): Promise<Row> {
        const object = (input.create?.object ?? input.update!.object) as RecordObject;
        const from = input.head.ownerId;
        const to = input.create?.toMemberId ?? input.update!.toMemberId;
        const wide = widen(context);
        const { moved, identity, owners } = input.unit
            ? { moved: input.unit.targets, identity: input.unit.identity, owners: undefined }
            : await this.widened(context, async (w) => {
                  const unit = await unitOf(w, object, input.head, from, input.scope ?? 'owner', to);
                  return { moved: unit.targets, identity: unit.identity, owners: unit.owners };
              });
        const now = new Date();
        const row = input.create
            ? await tx.ownershipTransfer.create({
                  data: { ...input.create, workspaceId: context.workspaceId, decidedAt: now, moved: moved as object[] },
                  include: INCLUDE,
              })
            : await tx.ownershipTransfer.update({
                  where: { id: input.update!.id },
                  data: { status: 'accepted', decidedByMemberId: input.me, decidedAt: now, moved: moved as object[] },
                  include: INCLUDE,
              });
        const updates = await this.widened(context, (w) => move(w, wide, moved, from, to, owners));
        if (input.silent) {
            // A backfill's move: its report says so; thousands of bells would say nothing.
        } else if (row.status === 'forced') {
            await tell(tx, row, to, 'transfer_received');
            // Everyone it took something from is told — under OWN-1b, each holder of a person or deal at the company.
            const losers = new Set([from, ...(owners?.values() ?? [])]);
            for (const loser of losers) {
                if (loser && loser !== input.me && loser !== to) await tell(tx, row, loser, 'transfer_taken');
            }
        } else if (row.proposedByMemberId !== input.me) {
            await tell(tx, row, row.proposedByMemberId, 'transfer_accepted');
        }
        await this.events.recordAll(tx, [event(context, 'transfer.completed', row, moved, identity), ...updates]);
        return row;
    }

    /** Runs `fn` in a transaction scoped to the workspace but not to the caller's own records. */
    private widened<T>(context: WorkspaceRunContext, fn: (tx: WorkspaceClient) => Promise<T>): Promise<T> {
        return this.context.run(widen(context), () => this.rls.withWorkspace(context.workspaceId, fn));
    }

    private current(): WorkspaceRunContext {
        const context = this.context.get();
        if (!context) throw new Error('TransfersService is used inside a workspace scope');
        return context;
    }
}

/** The caller's context without their owner scope (the class comment). */
function widen(context: WorkspaceRunContext): WorkspaceRunContext {
    const { ownerScopeMemberId: _scope, ...wide } = context;
    return wide;
}

async function openTransfer(tx: WorkspaceClient, id: string): Promise<Row> {
    const row = await tx.ownershipTransfer.findUnique({ where: { id }, include: INCLUDE });
    if (!row) throw new NotFoundException('transfer not found');
    if (row.status !== 'proposed') throw new ConflictException(`this transfer was ${row.status}`);
    return row;
}

/** The record, within the caller's scope: null when there is none the caller may see. */
async function findHead(
    tx: WorkspaceClient,
    context: WorkspaceRunContext,
    object: RecordObject,
    id: string,
): Promise<Head | null> {
    const where = { id, ...recordWhere(context, false) };
    switch (object) {
        case 'person':
            return tx.person.findFirst({ where, select: { id: true, ownerId: true, companyId: true } });
        case 'company': {
            const c = await tx.company.findFirst({ where, select: { id: true, ownerId: true } });
            return c ? { ...c, companyId: c.id } : null;
        }
        case 'opportunity':
            return tx.opportunity.findFirst({ where, select: { id: true, ownerId: true, companyId: true } });
    }
}

/** What moves with a record (the class comment), and the identities a receiver matches on. */
/** The rotation's contact on its own, when it is still `from`'s; null otherwise. */
async function contactAlone(
    tx: WorkspaceClient,
    personId: string,
    from: string,
): Promise<{ target: RecordTarget; email: string | null } | null> {
    const person = await tx.person.findFirst({
        where: { id: personId, deletedAt: null, ownerId: from },
        select: { id: true, emails: true },
    });
    if (!person) return null;
    const primary = (person.emails as Emails | null)?.primary;
    return { target: { type: 'person', id: person.id }, email: primary ? primary.toLowerCase() : null };
}

/** What a transfer moves: the records, whom each is taken from, and what a receiver matches it on. */
interface Unit {
    targets: RecordTarget[];
    /** Each target's owner as read (`id` → member, or null for nobody). */
    owners: Map<string, string | null>;
    identity: TransferEventPayload['identity'];
}

/**
 * A transfer's unit. `owner` (an offer, an accepted one): the records `from` holds — a company with its people and
 * open deals; a person with their company's unit when `from` holds the company, else with the open deals they are
 * the contact for; a deal alone. `company` (OWN-1b, a manager's move): a company, or a person at one, takes the
 * whole company — every live person at it and the open deals with it or with them, whoever holds them — so the
 * company and its contacts end up with one member; a person with no company takes their open deals the same way.
 * Records `to` already holds are left out.
 */
async function unitOf(
    tx: WorkspaceClient,
    object: RecordObject,
    head: Head,
    from: string | null,
    scope: 'owner' | 'company' = 'owner',
    to: string | null = null,
): Promise<Unit> {
    const targets: RecordTarget[] = [];
    const owners = new Map<string, string | null>();
    const emails: string[] = [];
    let companyDomain: string | null = null;
    // The receiver's own records stay out; records nobody owns are taken too (`<>` alone would drop them).
    const held =
        scope === 'owner' ? { ownerId: from } : to ? { OR: [{ ownerId: null }, { ownerId: { not: to } }] } : {};
    const push = (type: RecordObject, id: string, ownerId: string | null) => {
        if (owners.has(id)) return;
        targets.push({ type, id });
        owners.set(id, ownerId);
    };

    const addPeople = async (where: Prisma.PersonWhereInput) => {
        const people = await tx.person.findMany({
            where: { AND: [where, { deletedAt: null }, held] },
            select: { id: true, emails: true, ownerId: true },
        });
        for (const p of people) {
            push('person', p.id, p.ownerId);
            const primary = (p.emails as Emails | null)?.primary;
            if (primary) emails.push(primary.toLowerCase());
        }
        return people.map((p) => p.id);
    };
    const addDeals = async (where: Prisma.OpportunityWhereInput) => {
        const deals = await tx.opportunity.findMany({
            where: { AND: [where, { deletedAt: null, closedAt: null }, held] },
            select: { id: true, ownerId: true },
        });
        for (const d of deals) push('opportunity', d.id, d.ownerId);
    };
    const addCompany = async (companyId: string) => {
        const company = await tx.company.findFirst({
            where: { id: companyId, deletedAt: null, ...(scope === 'owner' ? { ownerId: from } : {}) },
            select: { id: true, domain: true, ownerId: true },
        });
        if (!company) return false;
        if (scope === 'owner' || company.ownerId !== to) push('company', company.id, company.ownerId);
        companyDomain = company.domain;
        if (scope === 'owner') {
            await addPeople({ companyId: company.id });
            await addDeals({ companyId: company.id });
            return true;
        }
        // The whole company: its people, whoever holds them, and the open deals with it or with them.
        const everyone = await tx.person.findMany({
            where: { companyId: company.id, deletedAt: null },
            select: { id: true },
        });
        await addPeople({ companyId: company.id });
        await addDeals({
            OR: [{ companyId: company.id }, { pointOfContactId: { in: everyone.map((p) => p.id) } }],
        });
        return true;
    };

    switch (object) {
        case 'company':
            if (!(await addCompany(head.id))) push('company', head.id, head.ownerId);
            break;
        case 'person': {
            const withCompany = head.companyId ? await addCompany(head.companyId) : false;
            if (!withCompany) {
                await addPeople({ id: head.id });
                if (targets.length === 0) push('person', head.id, head.ownerId);
                await addDeals({ pointOfContactId: head.id });
            } else if (!owners.has(head.id)) {
                await addPeople({ id: head.id });
            }
            break;
        }
        case 'opportunity':
            push('opportunity', head.id, head.ownerId);
            break;
    }
    return { targets, owners, identity: { companyDomain, personEmails: [...new Set(emails)] } };
}

/**
 * Changes each moved record's owner, from the owner it was read with (`owners`, else `from`), and returns its
 * `…updated` event. A record that moved meanwhile is skipped.
 */
async function move(
    tx: WorkspaceClient,
    context: WorkspaceRunContext,
    targets: readonly RecordTarget[],
    from: string | null,
    to: string,
    owners?: ReadonlyMap<string, string | null>,
): Promise<DomainEvent[]> {
    const events: DomainEvent[] = [];
    const base = {
        workspaceId: context.workspaceId,
        actor: actorOf(context),
        occurredAt: new Date().toISOString(),
    };
    for (const t of targets) {
        const was = owners?.has(t.id) ? (owners.get(t.id) ?? null) : from;
        const where = { id: t.id, ownerId: was, deletedAt: null };
        const data = { ownerId: to };
        const result =
            t.type === 'person'
                ? await tx.person.updateMany({ where, data })
                : t.type === 'company'
                  ? await tx.company.updateMany({ where, data })
                  : await tx.opportunity.updateMany({ where, data });
        if (result.count === 0) continue;
        events.push({
            ...base,
            diff: { ownerId: { from: was, to } },
            type: `${t.type}.updated`,
            object: t.type,
            recordId: t.id,
        } as DomainEvent);
    }
    return events;
}

/** OWN-1b: a manager's move of a company, or a person (at one), takes the whole company; a deal moves alone. */
function wholeCompany(object: RecordObject): 'owner' | 'company' {
    return object === 'opportunity' ? 'owner' : 'company';
}

/** A unit as its confirmation reads: by member, how many of each, and some of their names. */
async function previewOf(tx: WorkspaceClient, unit: Unit): Promise<TransferPreviewView> {
    const ids = (type: RecordObject) => unit.targets.filter((t) => t.type === type).map((t) => t.id);
    const [people, deals, companies] = await Promise.all([
        tx.person.findMany({
            where: { id: { in: ids('person') } },
            select: { id: true, nameFirst: true, nameLast: true },
        }),
        tx.opportunity.findMany({ where: { id: { in: ids('opportunity') } }, select: { id: true, name: true } }),
        tx.company.findMany({ where: { id: { in: ids('company') } }, select: { id: true, name: true } }),
    ]);
    const names = new Map<string, string>([
        ...people.map((p) => [p.id, `${p.nameFirst} ${p.nameLast}`.trim() || 'Unnamed person'] as const),
        ...deals.map((d) => [d.id, d.name] as const),
        ...companies.map((c) => [c.id, c.name] as const),
    ]);
    const memberIds = [...new Set([...unit.owners.values()].filter((m): m is string => m !== null))];
    const members = await tx.workspaceMember.findMany({
        where: { id: { in: memberIds } },
        select: { id: true, user: { select: { displayName: true } } },
    });
    const nameOf = new Map(members.map((m) => [m.id, m.user.displayName ?? null]));
    const byOwner = new Map<string | null, TransferPreviewView['losers'][number]>();
    // People and deals first: they are what a member loses; the company follows them.
    const order: RecordObject[] = ['person', 'opportunity', 'company'];
    const sorted = [...unit.targets].sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type));
    for (const t of sorted) {
        const owner = unit.owners.get(t.id) ?? null;
        const entry = byOwner.get(owner) ?? {
            member: owner ? { memberId: owner, name: nameOf.get(owner) ?? null } : null,
            companies: 0,
            people: 0,
            deals: 0,
            names: [],
        };
        if (t.type === 'company') entry.companies += 1;
        else if (t.type === 'person') entry.people += 1;
        else entry.deals += 1;
        if (entry.names.length < TRANSFER_PREVIEW_NAMES) entry.names.push(names.get(t.id) ?? 'Unnamed');
        byOwner.set(owner, entry);
    }
    const losers = [...byOwner.values()].sort(
        (a, b) => b.people + b.deals + b.companies - (a.people + a.deals + a.companies),
    );
    return { losers, total: unit.targets.length };
}

async function tell(tx: WorkspaceClient, row: Row, memberId: string, kind: NotificationKind): Promise<void> {
    await tx.notification.createMany({
        data: [{ workspaceId: row.workspaceId, memberId, kind, transferId: row.id }],
        skipDuplicates: true,
    });
}

function event(
    context: WorkspaceRunContext,
    type: 'transfer.proposed' | 'transfer.declined' | 'transfer.cancelled' | 'transfer.completed',
    row: Row,
    moved: RecordTarget[],
    identity: TransferEventPayload['identity'] = { companyDomain: null, personEmails: [] },
): DomainEvent {
    return {
        type,
        object: 'transfer',
        workspaceId: context.workspaceId,
        actor: actorOf(context),
        occurredAt: new Date().toISOString(),
        recordId: row.id,
        ...(type === 'transfer.completed' ? { targets: moved } : {}),
        transfer: {
            object: row.object,
            recordId: row.recordId,
            fromMemberId: row.fromMemberId,
            toMemberId: row.toMemberId,
            byMemberId: row.decidedByMemberId ?? row.proposedByMemberId,
            status: row.status,
            reason: row.reason,
            moved,
            identity,
        },
    };
}

async function labelsFor(tx: WorkspaceClient, ...rows: Row[]): Promise<ReadonlyMap<string, string>> {
    return labelTargets(
        tx,
        rows.flatMap((r) => [
            { targetType: r.object, targetId: r.recordId },
            ...(r.moved as RecordTarget[]).map((t) => ({ targetType: t.type, targetId: t.id })),
        ]),
    );
}

function member(m: Row['to'] | null): TransferMember | null {
    return m ? { memberId: m.id, name: m.user.displayName } : null;
}

export function view(row: Row, labels: ReadonlyMap<string, string>): TransferView {
    const moved: LabelledTarget[] = labelled(
        (row.moved as RecordTarget[]).map((t) => ({ targetType: t.type, targetId: t.id })),
        labels,
    );
    return {
        id: row.id,
        object: row.object,
        recordId: row.recordId,
        recordLabel: labels.get(`${row.object}:${row.recordId}`) ?? 'A record',
        from: member(row.from),
        to: member(row.to)!,
        proposedBy: member(row.proposedBy)!,
        decidedBy: member(row.decidedBy),
        status: row.status,
        reason: row.reason,
        note: row.note,
        moved,
        createdAt: row.createdAt.toISOString(),
        decidedAt: row.decidedAt?.toISOString() ?? null,
    };
}

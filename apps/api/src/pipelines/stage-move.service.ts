import { BadRequestException, Injectable, UnprocessableEntityException } from '@nestjs/common';
import type { EventActor, StageChange, StageHistoryReason, StageKind } from '@bylinecrm/shared';
import type { Prisma } from '@prisma/client';
import { DomainEvents } from '../events/domain-events.service';
import type { WorkspaceClient } from '../infra/rls-prisma.service';
import { moneyColumns, type MoneyInput } from '../records/references';
import { decideMove, moveEventType } from './stage-moves';

/** The columns a move reads and writes on a deal. */
export interface DealStageRow {
    id: string;
    workspaceId: string;
    pipelineId: string;
    stageId: string;
}

/** What closing a deal records: the amount it won at, or why it was lost. */
export interface ClosePayload {
    wonAmount?: MoneyInput | undefined;
    lostReason?: string | undefined;
}

export type MoveOutcome =
    { outcome: 'moved'; change: StageChange; toKind: StageKind } | { outcome: 'already' } | { outcome: 'backward' };

/**
 * The one writer of a deal's stage. A new deal is placed through `place`; every later change —
 * a member's move, a rule's, a close — goes through `move`, which writes the history row and the
 * deal's columns in the caller's transaction (or, when a stage is deleted, `moveAllInStage` for
 * every deal in it), and `announce` publishes what happened after it committed. No other code
 * sets `stage_id`.
 */
@Injectable()
export class StageMoveService {
    constructor(private readonly events: DomainEvents) {}

    /** The first history row of a deal that was just created in `stageId`. */
    async place(
        tx: WorkspaceClient,
        deal: DealStageRow,
        actor: EventActor,
        reason: Extract<StageHistoryReason, 'manual' | 'import'>,
    ): Promise<void> {
        const stage = await tx.pipelineStage.findUnique({ where: { id: deal.stageId }, select: { name: true } });
        if (!stage) throw new Error(`deal ${deal.id} is placed in a stage that does not exist`);
        await tx.opportunityStageHistory.create({
            data: {
                workspaceId: deal.workspaceId,
                opportunityId: deal.id,
                fromStageId: null,
                fromStageName: null,
                toStageId: deal.stageId,
                toStageName: stage.name,
                actor,
                reason,
            },
        });
    }

    /**
     * Moves `deal` to `toStageId`, which must be a stage of the deal's own pipeline. Backward moves
     * happen only when `allowBackward`; a move into a `won` or `lost` stage is a close and needs
     * the close payload; a move out of one reopens the deal.
     */
    async move(
        tx: WorkspaceClient,
        deal: DealStageRow,
        toStageId: string,
        actor: EventActor,
        options: { reason: StageHistoryReason; allowBackward: boolean; close?: ClosePayload | undefined },
    ): Promise<MoveOutcome> {
        const [from, to] = await Promise.all([
            tx.pipelineStage.findUnique({ where: { id: deal.stageId } }),
            tx.pipelineStage.findFirst({ where: { id: toStageId, pipelineId: deal.pipelineId } }),
        ]);
        if (!from) throw new Error(`deal ${deal.id} is in a stage that does not exist`);
        if (!to) throw new UnprocessableEntityException('stage is not in this deal’s pipeline');

        const decision = decideMove(from.position, to.position, options.allowBackward);
        if (decision.kind === 'already') return { outcome: 'already' };
        if (decision.kind === 'backward') return { outcome: 'backward' };

        const closing = to.kind !== 'open';
        if (closing && !options.close) {
            throw new BadRequestException(`moving into a ${to.kind} stage needs the close details`);
        }
        const reason: StageHistoryReason = closing ? 'close' : options.reason;
        const closeColumns = await closeColumnsFor(tx, deal.workspaceId, to.kind, options.close);

        // Only from the stage it was read in: two movers at once (the outbox relay and a redelivery, two rules) see
        // one move, and the second finds it already done, so a deal is never closed or announced twice.
        const { count } = await tx.opportunity.updateMany({
            where: { id: deal.id, stageId: from.id },
            data: { stageId: to.id, ...closeColumns },
        });
        if (count === 0) return { outcome: 'already' };
        await tx.opportunityStageHistory.create({
            data: {
                workspaceId: deal.workspaceId,
                opportunityId: deal.id,
                fromStageId: from.id,
                fromStageName: from.name,
                toStageId: to.id,
                toStageName: to.name,
                actor,
                reason,
            },
        });
        return {
            outcome: 'moved',
            toKind: to.kind,
            change: { pipelineId: deal.pipelineId, fromStageId: from.id, toStageId: to.id, reason },
        };
    }

    /**
     * Moves every deal in `from` — trashed ones included — into `to`, an open stage of the same
     * pipeline, because `from` is being deleted (P1-2b). Set-based (one update, one batch of history
     * rows) so a stage with thousands of deals moves inside one short transaction; every deal still
     * gets its history row and, once the caller announces the returned moves, exactly one event.
     * The target is open, so a deal that was won or lost is reopened (its close columns cleared) —
     * the same rule `move` applies.
     */
    async moveAllInStage(
        tx: WorkspaceClient,
        workspaceId: string,
        from: { id: string; pipelineId: string; name: string },
        to: { id: string; pipelineId: string; kind: StageKind; name: string },
        actor: EventActor,
    ): Promise<{ dealId: string; moved: Extract<MoveOutcome, { outcome: 'moved' }> }[]> {
        if (to.pipelineId !== from.pipelineId || to.kind !== 'open') {
            throw new Error('moveAllInStage moves into an open stage of the same pipeline only');
        }
        const deals = await tx.opportunity.findMany({ where: { stageId: from.id }, select: { id: true } });
        if (deals.length === 0) return [];
        const reason: StageHistoryReason = 'stage_deleted';
        await tx.opportunity.updateMany({
            where: { stageId: from.id },
            data: { stageId: to.id, ...(await closeColumnsFor(tx, workspaceId, 'open', undefined)) },
        });
        await tx.opportunityStageHistory.createMany({
            data: deals.map((deal) => ({
                workspaceId,
                opportunityId: deal.id,
                fromStageId: from.id,
                fromStageName: from.name,
                toStageId: to.id,
                toStageName: to.name,
                actor,
                reason,
            })),
        });
        const change: StageChange = { pipelineId: from.pipelineId, fromStageId: from.id, toStageId: to.id, reason };
        return deals.map((deal) => ({ dealId: deal.id, moved: { outcome: 'moved', toKind: 'open', change } }));
    }

    /**
     * Records a move as exactly one event (`moveEventType`), in the transaction that made it: `deal.won` or `deal.lost`
     * for a close, `deal.stage_changed` for every other move. All three are about the opportunity
     * and carry the same shape — the move as `diff.stageId`, the shape every `updated` event uses,
     * so the timeline writes it on the deal like any change, and `stage` for the pipeline and the
     * reason — so the timeline and webhooks need no case of their own.
     */
    announce(
        tx: WorkspaceClient,
        workspaceId: string,
        dealId: string,
        actor: EventActor,
        moved: Extract<MoveOutcome, { outcome: 'moved' }>,
    ): Promise<void> {
        return this.events.record(tx, {
            type: moveEventType(moved.toKind),
            object: 'opportunity',
            workspaceId,
            actor,
            occurredAt: new Date().toISOString(),
            recordId: dealId,
            diff: { stageId: { from: moved.change.fromStageId, to: moved.change.toStageId } },
            stage: moved.change,
        });
    }
}

/** What a close writes, and what a reopen clears. */
async function closeColumnsFor(
    tx: WorkspaceClient,
    workspaceId: string,
    kind: StageKind,
    close: ClosePayload | undefined,
): Promise<Prisma.OpportunityUncheckedUpdateInput> {
    if (kind === 'open') return { closedAt: null, lostReason: null };
    const amount = kind === 'won' && close?.wonAmount ? await moneyColumns(tx, workspaceId, close.wonAmount) : {};
    return {
        closedAt: new Date(),
        lostReason: kind === 'lost' ? (close?.lostReason ?? null) : null,
        ...(amount.amountMinor !== undefined ? { amountMinor: amount.amountMinor } : {}),
        ...(amount.currency ? { currency: amount.currency } : {}),
    };
}

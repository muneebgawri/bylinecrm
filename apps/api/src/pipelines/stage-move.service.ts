import { BadRequestException, Injectable, UnprocessableEntityException } from '@nestjs/common';
import type { Actor, StageChange, StageHistoryReason, StageKind } from '@bylinecrm/shared';
import type { Prisma } from '@prisma/client';
import { DomainEvents } from '../events/domain-events.service';
import type { WorkspaceClient } from '../infra/rls-prisma.service';
import { moneyColumns, type MoneyInput } from '../records/references';
import { decideMove } from './stage-moves';

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
 * deal's columns in the caller's transaction, and `announce` publishes what happened after it
 * committed. No other code sets `stage_id`.
 */
@Injectable()
export class StageMoveService {
    constructor(private readonly events: DomainEvents) {}

    /** The first history row of a deal that was just created in `stageId`. */
    async place(
        tx: WorkspaceClient,
        deal: DealStageRow,
        actor: Actor,
        reason: Extract<StageHistoryReason, 'manual' | 'import'>,
    ): Promise<void> {
        await tx.opportunityStageHistory.create({
            data: {
                workspaceId: deal.workspaceId,
                opportunityId: deal.id,
                fromStageId: null,
                toStageId: deal.stageId,
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
        actor: Actor,
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

        await tx.opportunity.update({ where: { id: deal.id }, data: { stageId: to.id, ...closeColumns } });
        await tx.opportunityStageHistory.create({
            data: {
                workspaceId: deal.workspaceId,
                opportunityId: deal.id,
                fromStageId: from.id,
                toStageId: to.id,
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

    /** Publishes a committed move: always `deal.stage_changed`, and `deal.won` / `deal.lost` on a close. */
    announce(
        workspaceId: string,
        dealId: string,
        actor: Actor,
        moved: Extract<MoveOutcome, { outcome: 'moved' }>,
    ): void {
        const base = {
            object: 'deal' as const,
            workspaceId,
            actor,
            occurredAt: new Date().toISOString(),
            recordId: dealId,
        };
        this.events.publish({ ...base, type: 'deal.stage_changed', stage: moved.change });
        if (moved.toKind === 'won') this.events.publish({ ...base, type: 'deal.won', stage: moved.change });
        if (moved.toKind === 'lost') this.events.publish({ ...base, type: 'deal.lost', stage: moved.change });
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

import { Injectable } from '@nestjs/common';
import {
    WON_DEAL_EXCLUSION_SOURCE,
    type CustomerExclusionSettingsView,
    type ExclusionReviewReason,
    type WonExclusionScope,
} from '@bylinecrm/shared';
import { UniqueConflict } from '../infra/errors/api-errors';
import { RlsPrismaService, type WorkspaceClient } from '../infra/rls-prisma.service';
import { WorkspaceContext } from '../infra/workspace-context';
import { ExclusionsService } from '../sequences/exclusions.service';
import { exclusionTarget } from './exclusion-target';

/** What the deal's facts are, read once for both the live path and the backfill. */
export async function wonDealFacts(tx: WorkspaceClient, dealId: string) {
    return tx.opportunity.findUnique({
        where: { id: dealId },
        select: {
            id: true,
            name: true,
            deletedAt: true,
            stage: { select: { kind: true } },
            company: { select: { domain: true } },
            pointOfContact: { select: { emailPrimary: true, company: { select: { domain: true } } } },
        },
    });
}

export type ExcludeOutcome = 'added' | 'already' | 'cleared_review' | 'no_address' | 'not_won';

/**
 * Won deals as customers for outreach (#242). Every way a deal is won — a member's move, a stage rule such as
 * `invoice.verified`, an import — announces `deal.won`, and the consumer calls `exclude` for it, so a won deal's
 * contact can no longer be enrolled in a cold sequence. A reopened or fully refunded deal never loses its exclusion
 * on its own: `flag` marks it for an admin to look at.
 */
@Injectable()
export class WonDealExclusions {
    constructor(
        private readonly rls: RlsPrismaService,
        private readonly context: WorkspaceContext,
        private readonly exclusions: ExclusionsService,
    ) {}

    async scope(tx: WorkspaceClient): Promise<WonExclusionScope> {
        const row = await tx.customerExclusionSettings.findFirst({ select: { wonExclusionScope: true } });
        return (row?.wonExclusionScope as WonExclusionScope | undefined) ?? 'address';
    }

    /** Adds the deal's exclusion in `tx` when it is (still) won; idempotent. `apply: false` only reports. */
    async exclude(tx: WorkspaceClient, workspaceId: string, dealId: string, apply = true): Promise<ExcludeOutcome> {
        const deal = await wonDealFacts(tx, dealId);
        if (!deal || deal.deletedAt || deal.stage.kind !== 'won') return 'not_won';
        const target = exclusionTarget(
            await this.scope(tx),
            deal.pointOfContact?.emailPrimary ?? null,
            deal.company?.domain ?? deal.pointOfContact?.company?.domain ?? null,
        );
        if (!target) return 'no_address';
        const live = await tx.outreachExclusion.findFirst({
            where: {
                removedAt: null,
                OR: [
                    ...(target.address ? [{ address: target.address }] : []),
                    { domain: target.domain ?? target.address!.slice(target.address!.lastIndexOf('@') + 1) },
                ],
            },
        });
        if (live) {
            // Won again after a reopen: the flag the reopen raised no longer applies.
            if (live.source === WON_DEAL_EXCLUSION_SOURCE && live.externalRef === dealId && live.reviewReason) {
                if (apply) {
                    await tx.outreachExclusion.update({
                        where: { id: live.id },
                        data: { reviewReason: null, reviewFlaggedAt: null },
                    });
                }
                return 'cleared_review';
            }
            return 'already';
        }
        if (!apply) return 'added';
        try {
            await this.exclusions.addIn(tx, workspaceId, {
                ...target,
                reason: 'customer',
                source: WON_DEAL_EXCLUSION_SOURCE,
                externalRef: dealId,
                note: `Won deal: ${deal.name}`.slice(0, 500),
            });
        } catch (error) {
            if (error instanceof UniqueConflict) return 'already'; // a concurrent add
            throw error;
        }
        return 'added';
    }

    /** Marks the deal's live automatic exclusions for an admin's review; a flag already raised stays as it was. */
    async flag(tx: WorkspaceClient, dealId: string, reason: ExclusionReviewReason): Promise<number> {
        const { count } = await tx.outreachExclusion.updateMany({
            where: { source: WON_DEAL_EXCLUSION_SOURCE, externalRef: dealId, removedAt: null, reviewReason: null },
            data: { reviewReason: reason, reviewFlaggedAt: new Date() },
        });
        return count;
    }

    // ── The admin setting ────────────────────────────────────────────────────────────────────

    settings(): Promise<CustomerExclusionSettingsView> {
        return this.rls.withWorkspace(async (tx) => ({ wonExclusionScope: await this.scope(tx) }));
    }

    /** Applies to deals won from now on; exclusions already made stay as they are. */
    setSettings(input: CustomerExclusionSettingsView): Promise<CustomerExclusionSettingsView> {
        const workspaceId = this.context.get()!.workspaceId;
        return this.rls.withWorkspace(async (tx) => {
            const row = await tx.customerExclusionSettings.upsert({
                where: { workspaceId },
                create: { workspaceId, wonExclusionScope: input.wonExclusionScope },
                update: { wonExclusionScope: input.wonExclusionScope },
            });
            return { wonExclusionScope: row.wonExclusionScope as WonExclusionScope };
        });
    }
}

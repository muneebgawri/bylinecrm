import { Injectable } from '@nestjs/common';
import { RlsPrismaService } from '../infra/rls-prisma.service';
import { WorkspaceContext, type WorkspaceRunContext } from '../infra/workspace-context';
import { acrossOwnerScope } from '../records/record-scope';
import type { DealFeedItem } from './responses';
export type { DealFeedItem } from './responses';

/** The deal timeline entries the feed shows, by what they say happened. */
export const DEAL_FEED_KINDS = {
    'opportunity.created': 'created',
    'deal.stage_changed': 'stage',
    'deal.won': 'won',
    'deal.lost': 'lost',
    'linked-invoice.verified': 'paid',
} as const;

export const DEAL_FEED_LIMIT = 30;

/**
 * Work people and rules do (`member`, `api_key`, `rule`); an import or a sync writes thousands of entries at once
 * and is left out. The kinds and actors are the query's and the partial index's, kept the same.
 */
interface FeedRow {
    id: string;
    kind: string;
    happenedAt: Date;
    actor: unknown;
    targetId: string;
    properties: unknown;
}

/**
 * The live deal feed: what the team is doing with deals, newest first, for everyone in the workspace. Read past
 * the caller's owner scope (OWN-2) and told as a headline only — the deal's name, amount, stage and owner, who did
 * it and when. `canOpen` says whether the caller may open the deal; nothing else of a deal they cannot is told.
 */
@Injectable()
export class DealFeedService {
    constructor(
        private readonly rls: RlsPrismaService,
        private readonly context: WorkspaceContext,
    ) {}

    latest(limit = DEAL_FEED_LIMIT): Promise<DealFeedItem[]> {
        const context = this.current();
        return acrossOwnerScope(this.rls, this.context, context, async (tx) => {
            // Written as the partial index `timeline_activities_deal_feed_idx` is, so the planner reads only it.
            const rows = await tx.$queryRaw<FeedRow[]>`
                SELECT id, kind, happened_at AS "happenedAt", actor, target_id AS "targetId", properties
                FROM timeline_activities
                WHERE workspace_id = ${context.workspaceId}::uuid
                  AND target_type = 'opportunity'
                  AND kind IN ('opportunity.created', 'deal.stage_changed', 'deal.won', 'deal.lost', 'linked-invoice.verified')
                  AND (actor ->> 'kind') IN ('member', 'api_key', 'rule')
                ORDER BY happened_at DESC, id
                LIMIT ${limit * 2}`;
            const deals = new Map(
                (
                    await tx.opportunity.findMany({
                        where: { id: { in: [...new Set(rows.map((r) => r.targetId))] }, deletedAt: null },
                        select: { id: true, name: true, amountMinor: true, currency: true, ownerId: true },
                    })
                ).map((d) => [d.id, d]),
            );
            const live = rows.filter((r) => deals.has(r.targetId)).slice(0, limit);
            const moves = live.map((r) => stageMove(r.properties));
            const stageIds = moves.flatMap((m) => [m.from, m.to]).filter((s): s is string => s !== null);
            const stages = new Map(
                (
                    await tx.pipelineStage.findMany({
                        where: { id: { in: [...new Set(stageIds)] } },
                        select: { id: true, name: true },
                    })
                ).map((s) => [s.id, s.name]),
            );
            const memberIds = [
                ...live.map((r) => actorMember(r.actor)),
                ...[...deals.values()].map((d) => d.ownerId),
            ].filter((m): m is string => m !== null);
            const members = new Map(
                (
                    await tx.workspaceMember.findMany({
                        where: { id: { in: [...new Set(memberIds)] } },
                        select: { id: true, user: { select: { displayName: true, email: true } } },
                    })
                ).map((m) => [m.id, m.user.displayName?.trim() || m.user.email]),
            );
            const person = (id: string | null) => (id ? { id, name: members.get(id) ?? null } : null);
            return live.map((r, index) => {
                const deal = deals.get(r.targetId)!;
                const actorKind = (r.actor as { kind?: string }).kind === 'rule' ? 'rule' : 'member';
                return {
                    id: r.id,
                    kind: DEAL_FEED_KINDS[r.kind as keyof typeof DEAL_FEED_KINDS],
                    happenedAt: r.happenedAt,
                    actor: { kind: actorKind, member: person(actorMember(r.actor)) },
                    deal: {
                        id: deal.id,
                        name: deal.name,
                        amount:
                            deal.amountMinor === null
                                ? null
                                : { amountMinor: Number(deal.amountMinor), currency: deal.currency },
                        owner: person(deal.ownerId),
                        canOpen:
                            context.capabilities.has('deal:read') &&
                            (!context.ownerScopeMemberId || deal.ownerId === context.ownerScopeMemberId),
                    },
                    fromStage: moves[index]!.from ? (stages.get(moves[index]!.from!) ?? null) : null,
                    toStage: moves[index]!.to ? (stages.get(moves[index]!.to!) ?? null) : null,
                };
            });
        });
    }

    private current(): WorkspaceRunContext {
        const context = this.context.get();
        if (!context) throw new Error('DealFeedService is used inside a workspace scope');
        return context;
    }
}

/** The member an entry is attributed to; null for a rule or an API key. */
function actorMember(actor: unknown): string | null {
    const a = actor as { kind?: string; id?: string | null } | null;
    return a?.kind === 'member' && a.id ? a.id : null;
}

/** A stage change's `diff.stageId`, from and to. */
function stageMove(properties: unknown): { from: string | null; to: string | null } {
    const change = (properties as { diff?: { stageId?: { from?: unknown; to?: unknown } } } | null)?.diff?.stageId;
    const id = (v: unknown) => (typeof v === 'string' ? v : null);
    return { from: id(change?.from), to: id(change?.to) };
}

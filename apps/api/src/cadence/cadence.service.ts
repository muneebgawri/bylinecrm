import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
    TRANSFER_REASON_CADENCE_ROTATION,
    type RotationPreviewItem,
    type RotationPreviewView,
} from '@bylinecrm/shared';
import { notify } from '../notifications/notify';
import { PrismaService } from '../infra/prisma.service';
import { uniqueViolation } from '../infra/prisma-errors';
import { RlsPrismaService, type WorkspaceClient } from '../infra/rls-prisma.service';
import type { WorkspaceRunContext } from '../infra/workspace-context';
import { coolingDays } from '../transfers/transfer-cooling';
import { TransfersService } from '../transfers/transfers.service';
import { eligible, pick, round } from './rotation-picker';
import { RotationService, type RotationRow } from './rotation.service';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Re-derives the cadence of the given deals and their contacts' overdue flag. */
export async function refreshCadence(tx: WorkspaceClient, ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    await tx.$queryRaw`SELECT refresh_cadence(${[...ids]}::uuid[])`;
}

const REFRESH_BATCH = 500;

/**
 * Re-derives the cadence of a workspace's deals (those `where` picks; by default every open one, and any still
 * carrying a cadence), a batch per transaction: one statement over every deal would hold their locks for minutes.
 */
export async function refreshCadenceInBatches(
    rls: RlsPrismaService,
    workspaceId: string,
    where: Prisma.OpportunityWhereInput = {
        OR: [{ closedAt: null, deletedAt: null }, { cadenceDueAt: { not: null } }, { cadenceOverdue: true }],
    },
): Promise<void> {
    let after: string | null = null;
    for (;;) {
        const last: string | null = await rls.withWorkspace(workspaceId, async (tx) => {
            const rows = await tx.opportunity.findMany({
                where: after ? { AND: [where, { id: { gt: after } }] } : where,
                select: { id: true },
                orderBy: { id: 'asc' },
                take: REFRESH_BATCH,
            });
            await refreshCadence(
                tx,
                rows.map((r) => r.id),
            );
            return rows.length === REFRESH_BATCH ? rows[rows.length - 1]!.id : null;
        });
        if (!last) return;
        after = last;
    }
}

/** An overdue open deal, as the job weighs it. */
interface Lapsed {
    id: string;
    name: string;
    ownerId: string;
    ownerName: string | null;
    stageName: string;
    cadenceDays: number;
    touchedAt: Date;
    dueAt: Date;
    pointOfContactId: string | null;
    contactOwnerId: string | null;
}

/** When the owner is warned: the due date, or the switch-on when later, plus the threshold. */
export function warnAt(dueAt: Date, enabledAt: Date, warnAfterDays: number): Date {
    return new Date(Math.max(dueAt.getTime(), enabledAt.getTime()) + warnAfterDays * DAY_MS);
}

const day = (d: Date) => d.toISOString().slice(0, 10);

/**
 * The hourly cadence job (CADENCE-1), and its dry run. Each run, per workspace:
 *
 * 1. **Refresh** every deal's cadence (`refresh_cadence`), and end pauses whose resume date passed.
 * 2. **Resolve** open lapses a touch, a close, a new owner or an exclusion ended.
 * 3. **Warn** (rotation on): an overdue deal past `warnAt` without an open lapse gets one — the owner is told once.
 * 4. **Rotate** (rotation on): a lapse past its `rotateAt`, still lapsed, is moved to the next rep by a forced
 *    transfer (`cadence_rotation`); managers are told. Nobody eligible: it waits for the next run.
 *
 * Idempotent: one open lapse per deal (a partial unique index), each warning a unique notification, and the rotation
 * claims its lapse under a row lock and checks the owner before it moves anything.
 */
@Injectable()
export class CadenceService {
    private readonly logger = new Logger(CadenceService.name);

    constructor(
        private readonly ownerPrisma: PrismaService,
        private readonly rls: RlsPrismaService,
        private readonly rotation: RotationService,
        private readonly transfers: TransfersService,
    ) {}

    async runAll(now = new Date()): Promise<void> {
        const workspaces = await this.ownerPrisma.workspace.findMany({ select: { id: true } });
        for (const w of workspaces) {
            try {
                await this.runWorkspace(w.id, now);
            } catch (error) {
                this.logger.error(`cadence ${w.id}: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }

    async runWorkspace(workspaceId: string, now = new Date()): Promise<{ warned: number; rotated: number }> {
        await refreshCadenceInBatches(this.rls, workspaceId);
        const settings = await this.rls.withWorkspace(workspaceId, async (tx) => {
            await tx.rotationMember.updateMany({
                where: { paused: true, resumeAt: { lte: now } },
                data: { paused: false, resumeAt: null },
            });
            await resolveLapses(tx, now);
            return this.rotation.settings(tx);
        });
        if (!settings.enabled || !settings.enabledAt) return { warned: 0, rotated: 0 };
        const warned = await this.warn(workspaceId, settings, now);
        const rotated = await this.rotateDue(workspaceId, settings, now);
        return { warned, rotated };
    }

    /** What the job would do now, as if rotation were on (from now, when it is off). Writes nothing. */
    async preview(workspaceId: string, now = new Date()): Promise<RotationPreviewView> {
        return this.rls.withWorkspace(workspaceId, async (tx) => {
            const settings = await this.rotation.settings(tx);
            const enabledAt = settings.enabled && settings.enabledAt ? settings.enabledAt : now;
            const lapsed = await lapsedDeals(tx, now);
            const open = new Map(
                (
                    await tx.cadenceLapse.findMany({
                        where: { resolvedAt: null, opportunityId: { in: lapsed.map((d) => d.id) } },
                    })
                ).map((l) => [l.opportunityId, l]),
            );
            const candidates = await this.rotation.candidates(tx);
            const turns = round(eligible(candidates, settings, now));
            const names = new Map(candidates.map((c) => [c.memberId, c.name]));
            let cursor = settings.cursor;
            const items: RotationPreviewItem[] = [];
            for (const d of lapsed) {
                const lapse = open.get(d.id);
                const warned = lapse?.warnedAt ?? warnAt(d.dueAt, enabledAt, settings.warnAfterDays);
                const rotateAt =
                    lapse?.rotateAt ??
                    new Date(Math.max(warned.getTime(), now.getTime()) + settings.graceDays * DAY_MS);
                const action = lapse ? (rotateAt <= now ? 'rotate' : 'waiting') : warned <= now ? 'warn' : 'waiting';
                let to: RotationPreviewItem['to'] = null;
                if (action === 'rotate') {
                    const next = pick(turns, cursor, await this.excluded(tx, d, now));
                    if (next) {
                        cursor = next.cursor;
                        to = { memberId: next.memberId, name: names.get(next.memberId) ?? null };
                    }
                }
                items.push({
                    opportunityId: d.id,
                    opportunityName: d.name,
                    stageName: d.stageName,
                    cadenceDays: d.cadenceDays,
                    owner: { memberId: d.ownerId, name: d.ownerName },
                    lastTouchAt: d.touchedAt.toISOString(),
                    dueAt: d.dueAt.toISOString(),
                    warnAt: warned.toISOString(),
                    rotateAt: rotateAt.toISOString(),
                    action,
                    to,
                });
            }
            return { assumedEnabledAt: enabledAt.toISOString(), overdue: items.length, items };
        });
    }

    // ── Steps ────────────────────────────────────────────────────────────────────────────────

    private async warn(workspaceId: string, settings: RotationRow, now: Date): Promise<number> {
        return this.rls.withWorkspace(workspaceId, async (tx) => {
            const lapsed = await lapsedDeals(tx, now);
            const open = new Set(
                (
                    await tx.cadenceLapse.findMany({
                        where: { resolvedAt: null, opportunityId: { in: lapsed.map((d) => d.id) } },
                        select: { opportunityId: true },
                    })
                ).map((l) => l.opportunityId),
            );
            let warned = 0;
            for (const d of lapsed) {
                if (open.has(d.id) || warnAt(d.dueAt, settings.enabledAt!, settings.warnAfterDays) > now) continue;
                let id: string;
                try {
                    id = (
                        await tx.cadenceLapse.create({
                            data: {
                                workspaceId,
                                opportunityId: d.id,
                                ownerMemberId: d.ownerId,
                                stageName: d.stageName,
                                cadenceDays: d.cadenceDays,
                                lastTouchAt: d.touchedAt,
                                dueAt: d.dueAt,
                                warnedAt: now,
                                rotateAt: new Date(now.getTime() + settings.graceDays * DAY_MS),
                            },
                            select: { id: true },
                        })
                    ).id;
                } catch (error) {
                    if (uniqueViolation(error)) continue;
                    throw error;
                }
                warned += await notify(tx, workspaceId, [d.ownerId], 'cadence_warning', [{ type: 'cadence', id }]);
            }
            return warned;
        });
    }

    private async rotateDue(workspaceId: string, settings: RotationRow, now: Date): Promise<number> {
        const due = await this.rls.withWorkspace(workspaceId, (tx) =>
            tx.cadenceLapse.findMany({
                where: { resolvedAt: null, rotateAt: { lte: now } },
                orderBy: [{ rotateAt: 'asc' }, { id: 'asc' }],
                select: { id: true },
            }),
        );
        let rotated = 0;
        for (const { id } of due) {
            try {
                if (await this.rotateOne(workspaceId, id, settings, now)) rotated += 1;
            } catch (error) {
                this.logger.error(`rotate lapse ${id}: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        return rotated;
    }

    /** One due lapse, claimed under its row lock: moved to the next rep, or left waiting when nobody is eligible. */
    private async rotateOne(workspaceId: string, lapseId: string, settings: RotationRow, now: Date): Promise<boolean> {
        const moved = await this.rls.withWorkspace(workspaceId, async (tx): Promise<string | null> => {
            const [claimed] = await tx.$queryRaw<{ id: string }[]>`
                SELECT "id" FROM "cadence_lapses" WHERE "id" = ${lapseId}::uuid AND "resolved_at" IS NULL
                FOR UPDATE SKIP LOCKED`;
            if (!claimed) return null;
            const lapse = await tx.cadenceLapse.findUniqueOrThrow({ where: { id: lapseId } });
            const deal = (await lapsedDeals(tx, now, [lapse.opportunityId]))[0];
            if (!deal || deal.ownerId !== lapse.ownerMemberId) {
                await resolveLapses(tx, now, [lapse.opportunityId]);
                return null;
            }
            const to = await this.rotation.deal(tx, workspaceId, { exclude: await this.excluded(tx, deal, now), now });
            if (!to) {
                await tx.cadenceLapse.update({ where: { id: lapseId }, data: { blockedReason: 'no_eligible_member' } });
                return null;
            }
            // The contact goes too only when every open deal of theirs this owner holds has lapsed: otherwise the
            // owner keeps the contact for the deals they are still working.
            const withContact =
                deal.pointOfContactId && deal.contactOwnerId === deal.ownerId
                    ? (await tx.opportunity.count({
                          where: {
                              pointOfContactId: deal.pointOfContactId,
                              ownerId: deal.ownerId,
                              deletedAt: null,
                              closedAt: null,
                              id: { not: deal.id },
                              NOT: { cadenceLapses: { some: { resolvedAt: null } } },
                          },
                      })) === 0
                        ? deal.pointOfContactId
                        : undefined
                    : undefined;
            const context: WorkspaceRunContext = {
                workspaceId,
                capabilities: new Set(),
                actor: { kind: 'system', id: null },
            };
            const transfer = await this.transfers.rotate(context, {
                recordId: deal.id,
                withContact,
                from: deal.ownerId,
                to,
                reason: TRANSFER_REASON_CADENCE_ROTATION,
                note:
                    `No qualifying touch since ${day(deal.touchedAt)}: ${deal.stageName} expects one every ` +
                    `${deal.cadenceDays} day${deal.cadenceDays === 1 ? '' : 's'}. ${deal.ownerName ?? 'The owner'} was ` +
                    `warned on ${day(lapse.warnedAt)}, and ${settings.graceDays} more days passed without one.`,
            });
            if (!transfer) {
                await resolveLapses(tx, now, [lapse.opportunityId]);
                return null;
            }
            await tx.cadenceLapse.update({
                where: { id: lapseId },
                data: { resolvedAt: now, resolution: 'rotated', transferId: transfer.id, blockedReason: null },
            });
            const managers = await tx.workspaceMember.findMany({
                where: {
                    leftAt: null,
                    id: { notIn: [deal.ownerId, to] },
                    role: {
                        OR: [
                            { isSystem: true, name: 'admin' },
                            { permissions: { some: { capability: 'pipeline:cadence' } } },
                        ],
                    },
                },
                select: { id: true },
            });
            await notify(
                tx,
                workspaceId,
                managers.map((m) => m.id),
                'cadence_rotated',
                [{ type: 'transfer', id: transfer.id }],
            );
            return deal.id;
        });
        if (!moved) return false;
        // After the lapse's lock is released: the cadence consumer refreshes the deal, then resolves its lapses, so
        // refreshing it while holding the lapse would deadlock with it.
        await this.rls.withWorkspace(workspaceId, (tx) => refreshCadence(tx, [moved]));
        return true;
    }

    /**
     * Never the owner it lapsed under, nor anyone it was transferred away from within the workspace's transfer
     * cooling period (Settings → Ownership, #253): the rotation does not hand a lead back to whom it just left.
     */
    private async excluded(tx: WorkspaceClient, deal: Lapsed, now: Date): Promise<Set<string>> {
        const days = await coolingDays(tx);
        if (days <= 0) return new Set([deal.ownerId]);
        const handed = await tx.$queryRaw<{ from_member_id: string }[]>`
            SELECT DISTINCT "from_member_id" FROM "ownership_transfers"
            WHERE "from_member_id" IS NOT NULL AND "status" IN ('accepted', 'forced')
              AND "decided_at" > ${new Date(now.getTime() - days * DAY_MS)}
              AND ("moved" @> jsonb_build_array(jsonb_build_object('type', 'opportunity', 'id', ${deal.id}::text))
                   OR ("record_id" = ${deal.id}::uuid AND "object" = 'opportunity'))`;
        return new Set([deal.ownerId, ...handed.map((h) => h.from_member_id)]);
    }
}

/** The overdue open deals in scope (or those of `ids`), oldest due first. */
async function lapsedDeals(tx: WorkspaceClient, now: Date, ids?: readonly string[]): Promise<Lapsed[]> {
    const rows = await tx.opportunity.findMany({
        where: {
            deletedAt: null,
            closedAt: null,
            ownerId: { not: null },
            cadenceDueAt: { lte: now },
            cadenceTouchedAt: { not: null },
            ...(ids ? { id: { in: [...ids] } } : {}),
        },
        orderBy: [{ cadenceDueAt: 'asc' }, { id: 'asc' }],
        select: {
            id: true,
            name: true,
            ownerId: true,
            owner: { select: { user: { select: { displayName: true } } } },
            stage: { select: { name: true, cadenceDays: true } },
            cadenceTouchedAt: true,
            cadenceDueAt: true,
            pointOfContactId: true,
            pointOfContact: { select: { ownerId: true } },
        },
    });
    return rows.flatMap((r) =>
        r.ownerId && r.cadenceDueAt && r.cadenceTouchedAt && r.stage.cadenceDays
            ? [
                  {
                      id: r.id,
                      name: r.name,
                      ownerId: r.ownerId,
                      ownerName: r.owner?.user.displayName ?? null,
                      stageName: r.stage.name,
                      cadenceDays: r.stage.cadenceDays,
                      touchedAt: r.cadenceTouchedAt,
                      dueAt: r.cadenceDueAt,
                      pointOfContactId: r.pointOfContactId,
                      contactOwnerId: r.pointOfContact?.ownerId ?? null,
                  },
              ]
            : [],
    );
}

/**
 * Ends the open lapses (of `ids`, or all) that no longer hold: the deal closed or went, changed hands, left the
 * cadence's scope, or was touched since the lapse began.
 */
export async function resolveLapses(tx: WorkspaceClient, now: Date, ids?: readonly string[]): Promise<number> {
    if (ids && ids.length === 0) return 0;
    const open = await tx.cadenceLapse.findMany({
        where: { resolvedAt: null, ...(ids ? { opportunityId: { in: [...ids] } } : {}) },
        select: {
            id: true,
            ownerMemberId: true,
            lastTouchAt: true,
            opportunity: { select: { deletedAt: true, closedAt: true, ownerId: true, cadenceTouchedAt: true } },
        },
    });
    let resolved = 0;
    for (const l of open) {
        const o = l.opportunity;
        const resolution =
            o.deletedAt || o.closedAt
                ? 'closed'
                : o.ownerId !== l.ownerMemberId
                  ? 'owner_changed'
                  : !o.cadenceTouchedAt
                    ? 'out_of_scope'
                    : o.cadenceTouchedAt > l.lastTouchAt
                      ? 'touched'
                      : null;
        if (!resolution) continue;
        const { count } = await tx.cadenceLapse.updateMany({
            where: { id: l.id, resolvedAt: null },
            data: { resolvedAt: now, resolution },
        });
        resolved += count;
    }
    return resolved;
}

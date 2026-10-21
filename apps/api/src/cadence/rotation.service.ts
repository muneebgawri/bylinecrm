import { Injectable } from '@nestjs/common';
import { SYSTEM_ROLES, type MailboxPreference, type RotationSettingsView } from '@bylinecrm/shared';
import type { RotationSettings } from '@prisma/client';
import type { WorkspaceClient } from '../infra/rls-prisma.service';
import type { WorkspaceRunContext } from '../infra/workspace-context';
import { eligible, pick, round, type RotationCandidate } from './rotation-picker';

/** The settings a workspace without a row has. */
export const ROTATION_DEFAULTS: Omit<RotationSettings, 'workspaceId' | 'updatedAt'> = {
    enabled: false,
    enabledAt: null,
    warnAfterDays: 0,
    graceDays: 7,
    intakeEnabled: false,
    mailboxPreference: 'prefer',
    openLeadCap: null,
    cursor: 0,
};

export type RotationRow = Omit<RotationSettings, 'workspaceId' | 'updatedAt'>;

export interface CandidateRow extends RotationCandidate {
    name: string | null;
    email: string;
    roleName: string;
    includedByDefault: boolean;
}

/** Admins and managers run the rotation; everyone else is in it until someone says otherwise. */
function inByDefault(role: { name: string; isSystem: boolean }): boolean {
    return !(role.isSystem && (role.name === SYSTEM_ROLES.admin || role.name === SYSTEM_ROLES.manager));
}

export function settingsView(row: RotationRow): RotationSettingsView {
    return {
        enabled: row.enabled,
        enabledAt: row.enabledAt?.toISOString() ?? null,
        warnAfterDays: row.warnAfterDays,
        graceDays: row.graceDays,
        intakeEnabled: row.intakeEnabled,
        mailboxPreference: row.mailboxPreference as MailboxPreference,
        openLeadCap: row.openLeadCap,
    };
}

/**
 * The round-robin (CADENCE-1): who is in the rotation, and the next of them in turn. `deal` takes the workspace's
 * pointer under a row lock (`SELECT … FOR UPDATE` on `rotation_settings`), so concurrent intakes and rotations in
 * one workspace are dealt one after the other and nobody is dealt twice in a row by a race. Callers run it inside
 * their own transaction; the lock holds until it commits.
 */
@Injectable()
export class RotationService {
    async settings(tx: WorkspaceClient): Promise<RotationRow> {
        return (await tx.rotationSettings.findFirst()) ?? ROTATION_DEFAULTS;
    }

    /** Every active seat, as the rotation weighs them. */
    async candidates(tx: WorkspaceClient): Promise<CandidateRow[]> {
        const members = await tx.workspaceMember.findMany({
            where: { leftAt: null },
            select: {
                id: true,
                user: { select: { displayName: true, email: true } },
                role: { select: { name: true, isSystem: true } },
                rotationMembership: true,
                mailboxes: { where: { status: 'connected', purpose: 'personal' }, select: { id: true }, take: 1 },
                _count: { select: { ownedOpportunities: { where: { deletedAt: null, closedAt: null } } } },
            },
            orderBy: { id: 'asc' },
        });
        return members.map((m) => {
            const byDefault = inByDefault(m.role);
            const row = m.rotationMembership;
            return {
                memberId: m.id,
                name: m.user.displayName,
                email: m.user.email,
                roleName: m.role.name,
                includedByDefault: byDefault,
                included: row?.included ?? byDefault,
                paused: row?.paused ?? false,
                resumeAt: row?.resumeAt ?? null,
                weight: row?.weight ?? 1,
                hasMailbox: m.mailboxes.length > 0,
                openLeads: m._count.ownedOpportunities,
            };
        });
    }

    /**
     * The next eligible member in turn, never one in `exclude`; the pointer moves past them. Null when nobody is
     * eligible (the pointer stays).
     */
    async deal(
        tx: WorkspaceClient,
        workspaceId: string,
        options: { exclude?: ReadonlySet<string>; now?: Date } = {},
    ): Promise<string | null> {
        const now = options.now ?? new Date();
        await tx.$executeRaw`
            INSERT INTO "rotation_settings" ("workspace_id", "updated_at") VALUES (${workspaceId}::uuid, now())
            ON CONFLICT ("workspace_id") DO NOTHING`;
        const [locked] = await tx.$queryRaw<
            { cursor: number; mailbox_preference: string; open_lead_cap: number | null }[]
        >`
            SELECT "cursor", "mailbox_preference", "open_lead_cap" FROM "rotation_settings"
            WHERE "workspace_id" = ${workspaceId}::uuid FOR UPDATE`;
        if (!locked) return null;
        const turns = round(
            eligible(
                await this.candidates(tx),
                {
                    mailboxPreference: locked.mailbox_preference as MailboxPreference,
                    openLeadCap: locked.open_lead_cap,
                },
                now,
            ),
        );
        const next = pick(turns, locked.cursor, options.exclude ?? new Set());
        if (!next) return null;
        await tx.rotationSettings.update({ where: { workspaceId }, data: { cursor: next.cursor } });
        return next.memberId;
    }

    /** Intake: the next member for a new unowned lead, when the workspace deals them; else null. */
    async dealIntake(tx: WorkspaceClient, workspaceId: string): Promise<string | null> {
        const settings = await this.settings(tx);
        if (!settings.intakeEnabled) return null;
        return this.deal(tx, workspaceId);
    }

    /**
     * The owner a record saved without one takes: for an API key or a job (web and inbound routes, imports) and a
     * company nobody owns, the next member in turn when intake is on; else `ownerId` as it was. A member saving a
     * record unowned meant it.
     */
    async intakeOwner(
        tx: WorkspaceClient,
        context: WorkspaceRunContext,
        ownerId: string | null,
        companyId: string | null,
    ): Promise<string | null> {
        if (ownerId !== null || context.memberId !== undefined) return ownerId;
        if (companyId) {
            const company = await tx.company.findUnique({ where: { id: companyId }, select: { ownerId: true } });
            if (company?.ownerId) return ownerId;
        }
        return this.dealIntake(tx, context.workspaceId);
    }
}

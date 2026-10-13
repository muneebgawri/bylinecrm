import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { SYSTEM_ROLES } from '@bylinecrm/shared';
import { revokeAllSessions } from '../auth/session.service';
import { PrismaService } from '../infra/prisma.service';
import { RlsPrismaService, type WorkspaceClient } from '../infra/rls-prisma.service';
import { MEMBER_SUMMARY_SELECT, memberSummaryOf } from '../records/summaries';
import type { MemberSummaryView, MemberView } from './responses';
export type { MemberSummaryView, MemberView } from './responses';

/**
 * Members of the current workspace. Three rules live here and nowhere else: a member's role is
 * changed only through `setRole`, a workspace never loses its last admin, and a member is removed
 * by marking when they left (#147) — the row stays, so every send, enrolment and timeline row that
 * names them keeps its name; their sessions are revoked and the guard refuses them from the next
 * request. A seat that was left is not listed, not a member, and comes back as the same seat when
 * the address is invited again.
 */
@Injectable()
export class MembersService {
    constructor(
        private readonly rls: RlsPrismaService,
        // Sessions are a global table: the removed member's are revoked through the owner client,
        // the one writer of sessions, once the seat is marked left.
        private readonly ownerPrisma: PrismaService,
    ) {}

    list(): Promise<MemberView[]> {
        return this.rls.withWorkspace(async (tx) => {
            const members = await tx.workspaceMember.findMany({
                where: { leftAt: null },
                include: { user: { select: { email: true, displayName: true } }, role: { select: { name: true } } },
                orderBy: { createdAt: 'asc' },
            });
            return members.map((m) => ({
                id: m.id,
                userId: m.userId,
                email: m.user.email,
                displayName: m.user.displayName,
                roleId: m.roleId,
                roleName: m.role.name,
                createdAt: m.createdAt,
            }));
        });
    }

    /**
     * For owner, assignee and contact pickers, and for the name on every row a member left behind:
     * readable by anyone who reads records. A member who left is here with `leftAt` set — a picker
     * leaves them out, a timeline or a send still names them (#147).
     */
    summary(): Promise<MemberSummaryView[]> {
        return this.rls.withWorkspace(async (tx) => {
            const members = await tx.workspaceMember.findMany({
                select: MEMBER_SUMMARY_SELECT,
                orderBy: [{ user: { displayName: 'asc' } }, { createdAt: 'asc' }],
            });
            return members.map(memberSummaryOf);
        });
    }

    setRole(memberId: string, roleId: string): Promise<void> {
        return this.rls.withWorkspace(async (tx) => {
            const member = await tx.workspaceMember.findFirst({
                where: { id: memberId, leftAt: null },
                include: { role: true },
            });
            if (!member) throw new NotFoundException('member not found');
            const role = await tx.role.findUnique({ where: { id: roleId } });
            if (!role) throw new NotFoundException('role not found');
            if (isAdmin(member.role) && !isAdmin(role)) await assertNotLastAdmin(tx, member.workspaceId, memberId);
            await tx.workspaceMember.update({ where: { id: memberId }, data: { roleId } });
        });
    }

    async remove(memberId: string): Promise<void> {
        const userId = await this.rls.withWorkspace(async (tx) => {
            const member = await tx.workspaceMember.findFirst({
                where: { id: memberId, leftAt: null },
                include: { role: true },
            });
            if (!member) throw new NotFoundException('member not found');
            if (isAdmin(member.role)) await assertNotLastAdmin(tx, member.workspaceId, memberId);
            await tx.workspaceMember.update({ where: { id: memberId }, data: { leftAt: new Date() } });
            return member.userId;
        });
        // The seat is gone when this runs; the guard already refuses them. Their sessions end too,
        // so a tab they left open is signed out rather than shown refusals.
        await this.ownerPrisma.$transaction((tx) => revokeAllSessions(tx, userId));
    }
}

function isAdmin(role: { name: string; isSystem: boolean }): boolean {
    return role.isSystem && role.name === SYSTEM_ROLES.admin;
}

/**
 * Locks the workspace's admin seats for the rest of the transaction, then counts them without
 * the one being changed. Two concurrent demotions therefore serialise, and the second one sees
 * the count the first one left.
 */
async function assertNotLastAdmin(tx: WorkspaceClient, workspaceId: string, exceptMemberId: string): Promise<void> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT m.id FROM workspace_members m
        JOIN roles r ON r.id = m.role_id
        WHERE m.workspace_id = ${workspaceId}::uuid AND m.left_at IS NULL AND r.is_system AND r.name = ${SYSTEM_ROLES.admin}
        FOR UPDATE OF m`;
    const remaining = rows.filter((r) => r.id !== exceptMemberId).length;
    if (remaining === 0) throw new ConflictException('a workspace keeps at least one admin');
}

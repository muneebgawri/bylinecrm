import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { SYSTEM_ROLES } from '@bylinecrm/shared';
import { RlsPrismaService, type WorkspaceClient } from '../infra/rls-prisma.service';
import type { MemberSummaryView, MemberView } from './responses';
export type { MemberSummaryView, MemberView } from './responses';

/**
 * Members of the current workspace. Two rules live here and nowhere else: a member's role is
 * changed only through `setRole`, and a workspace never loses its last admin.
 */
@Injectable()
export class MembersService {
    constructor(private readonly rls: RlsPrismaService) {}

    list(): Promise<MemberView[]> {
        return this.rls.withWorkspace(async (tx) => {
            const members = await tx.workspaceMember.findMany({
                include: { user: { select: { email: true } }, role: { select: { name: true } } },
                orderBy: { createdAt: 'asc' },
            });
            return members.map((m) => ({
                id: m.id,
                userId: m.userId,
                email: m.user.email,
                roleId: m.roleId,
                roleName: m.role.name,
                createdAt: m.createdAt,
            }));
        });
    }

    /** For owner, assignee and contact pickers: readable by anyone who reads records. */
    summary(): Promise<MemberSummaryView[]> {
        return this.rls.withWorkspace(async (tx) => {
            const members = await tx.workspaceMember.findMany({
                select: { id: true, displayName: true },
                orderBy: [{ displayName: 'asc' }, { createdAt: 'asc' }],
            });
            return members.map((m) => ({ memberId: m.id, name: m.displayName }));
        });
    }

    setRole(memberId: string, roleId: string): Promise<void> {
        return this.rls.withWorkspace(async (tx) => {
            const member = await tx.workspaceMember.findUnique({ where: { id: memberId }, include: { role: true } });
            if (!member) throw new NotFoundException('member not found');
            const role = await tx.role.findUnique({ where: { id: roleId } });
            if (!role) throw new NotFoundException('role not found');
            if (isAdmin(member.role) && !isAdmin(role)) await assertNotLastAdmin(tx, member.workspaceId, memberId);
            await tx.workspaceMember.update({ where: { id: memberId }, data: { roleId } });
        });
    }

    remove(memberId: string): Promise<void> {
        return this.rls.withWorkspace(async (tx) => {
            const member = await tx.workspaceMember.findUnique({ where: { id: memberId }, include: { role: true } });
            if (!member) throw new NotFoundException('member not found');
            if (isAdmin(member.role)) await assertNotLastAdmin(tx, member.workspaceId, memberId);
            await tx.workspaceMember.delete({ where: { id: memberId } });
        });
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
        WHERE m.workspace_id = ${workspaceId}::uuid AND r.is_system AND r.name = ${SYSTEM_ROLES.admin}
        FOR UPDATE OF m`;
    const remaining = rows.filter((r) => r.id !== exceptMemberId).length;
    if (remaining === 0) throw new ConflictException('a workspace keeps at least one admin');
}

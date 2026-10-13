import { Injectable } from '@nestjs/common';
import { RlsPrismaService } from '../infra/rls-prisma.service';
import type { WorkspaceView } from '../auth/auth.service';
import { workspaceView } from '../auth/auth.service';

/** A user's seat in one workspace, as the workspace guard needs it. */
export interface Membership {
    memberId: string;
    roleId: string;
}

/**
 * What a signed-in user may know before choosing a workspace: their own memberships. Read through
 * the restricted client under the `app.user_id` setting, whose policies show exactly those rows
 * and nothing tenant-scoped — so a non-member's lookup touches no tenant data at all.
 */
@Injectable()
export class MembershipService {
    constructor(private readonly rls: RlsPrismaService) {}

    find(userId: string, workspaceId: string): Promise<Membership | null> {
        return this.rls.withUser(userId, async (tx) => {
            // A seat that was left (#147) is no seat: the guard refuses from this request on.
            const member = await tx.workspaceMember.findFirst({
                where: { userId, workspaceId, leftAt: null },
                select: { id: true, roleId: true },
            });
            return member ? { memberId: member.id, roleId: member.roleId } : null;
        });
    }

    workspacesOf(userId: string): Promise<WorkspaceView[]> {
        return this.rls.withUser(userId, async (tx) => {
            const workspaces = await tx.workspace.findMany({ orderBy: { createdAt: 'asc' } });
            return workspaces.map(workspaceView);
        });
    }
}

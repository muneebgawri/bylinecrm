import type { WorkspaceClient } from '../infra/rls-prisma.service';
import { capabilitiesOf } from '../workspace/roles.service';

/**
 * Who may run an importer, and so who is told when its automatic sync keeps failing (#185, BIGIN-1):
 * the members whose role holds `workspace:admin` — resolved the way the guard resolves it, since the
 * system admin role is every capability without stored rows.
 */
export async function workspaceAdmins(tx: WorkspaceClient): Promise<{ id: string; email: string }[]> {
    const members = await tx.workspaceMember.findMany({
        where: { leftAt: null },
        select: {
            id: true,
            user: { select: { email: true } },
            role: { select: { name: true, isSystem: true, permissions: { select: { capability: true } } } },
        },
    });
    return members
        .filter((m) =>
            capabilitiesOf(
                m.role,
                m.role.permissions.map((p) => p.capability),
            ).has('workspace:admin'),
        )
        .map((m) => ({ id: m.id, email: m.user.email }));
}

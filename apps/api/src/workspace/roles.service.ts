import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { CAPABILITIES, SYSTEM_ROLES, isCapability, type Capability, type RecordScope } from '@bylinecrm/shared';
import { uniqueViolation } from '../infra/prisma-errors';
import { RlsPrismaService, type WorkspaceClient } from '../infra/rls-prisma.service';
import type { RoleView } from './responses';
export type { RoleView } from './responses';

/** What a role grants, as the workspace guard needs it: the capabilities, how far they reach, and which role. */
export interface RoleAccess {
    roleId: string;
    roleName: string;
    capabilities: ReadonlySet<Capability>;
    recordScope: RecordScope;
}

/**
 * What a role lets its holder do. The system `admin` role is every capability by construction:
 * it has no stored rows, so there is no list to drift. Any other role is exactly its rows.
 */
export function capabilitiesOf(
    role: { name: string; isSystem: boolean },
    stored: readonly string[],
): ReadonlySet<Capability> {
    if (role.isSystem && role.name === SYSTEM_ROLES.admin) return new Set(CAPABILITIES);
    return new Set(stored.filter(isCapability));
}

@Injectable()
export class RolesService {
    constructor(private readonly rls: RlsPrismaService) {}

    list(): Promise<RoleView[]> {
        return this.rls.withWorkspace(async (tx) => {
            const roles = await tx.role.findMany({ include: { permissions: true }, orderBy: { createdAt: 'asc' } });
            return roles.map(view);
        });
    }

    /** What one role grants, for the workspace guard. */
    access(workspaceId: string, roleId: string): Promise<RoleAccess | null> {
        return this.rls.withWorkspace(workspaceId, async (tx) => {
            const role = await tx.role.findUnique({ where: { id: roleId }, include: { permissions: true } });
            return role
                ? {
                      roleId: role.id,
                      roleName: role.name,
                      capabilities: capabilitiesOf(
                          role,
                          role.permissions.map((p) => p.capability),
                      ),
                      recordScope: role.recordScope,
                  }
                : null;
        });
    }

    create(name: string, capabilities: Capability[], recordScope: RecordScope = 'all'): Promise<RoleView> {
        return this.rls.withWorkspace(async (tx) => {
            const { workspaceId } = await currentWorkspace(tx);
            try {
                const role = await tx.role.create({
                    data: {
                        workspaceId,
                        name,
                        recordScope,
                        permissions: { create: capabilities.map((capability) => ({ workspaceId, capability })) },
                    },
                    include: { permissions: true },
                });
                return view(role);
            } catch (error) {
                throw uniqueViolation(error) ? new ConflictException('a role with that name exists') : error;
            }
        });
    }

    /**
     * Renames a role, replaces its capability list and/or changes its record scope. The admin
     * role's capabilities cannot be edited (they are not stored) and its scope is always `all`;
     * its name, and `member`'s, cannot change either.
     */
    update(
        roleId: string,
        patch: {
            name?: string | undefined;
            capabilities?: Capability[] | undefined;
            recordScope?: RecordScope | undefined;
        },
    ): Promise<RoleView> {
        return this.rls.withWorkspace(async (tx) => {
            const role = await tx.role.findUnique({ where: { id: roleId } });
            if (!role) throw new NotFoundException('role not found');
            if (role.isSystem && patch.name !== undefined && patch.name !== role.name) {
                throw new UnprocessableEntityException('a system role keeps its name');
            }
            const isAdmin = role.isSystem && role.name === SYSTEM_ROLES.admin;
            if (isAdmin && patch.capabilities !== undefined) {
                throw new UnprocessableEntityException('the admin role holds every capability');
            }
            if (isAdmin && patch.recordScope !== undefined && patch.recordScope !== 'all') {
                throw new UnprocessableEntityException('the admin role reaches every record');
            }
            if (patch.capabilities !== undefined) {
                await tx.rolePermission.deleteMany({ where: { roleId } });
                await tx.rolePermission.createMany({
                    data: patch.capabilities.map((capability) => ({
                        workspaceId: role.workspaceId,
                        roleId,
                        capability,
                    })),
                });
            }
            const updated = await tx.role.update({
                where: { id: roleId },
                data: {
                    ...(patch.name !== undefined ? { name: patch.name } : {}),
                    ...(patch.recordScope !== undefined ? { recordScope: patch.recordScope } : {}),
                },
                include: { permissions: true },
            });
            return view(updated);
        });
    }

    /** A custom role with no holders can be removed; system roles and roles in use cannot. */
    remove(roleId: string): Promise<void> {
        return this.rls.withWorkspace(async (tx) => {
            const role = await tx.role.findUnique({
                where: { id: roleId },
                include: { _count: { select: { members: true, apiKeys: true, invites: true } } },
            });
            if (!role) throw new NotFoundException('role not found');
            if (role.isSystem) throw new UnprocessableEntityException('a system role cannot be deleted');
            const holders = role._count.members + role._count.apiKeys + role._count.invites;
            if (holders > 0) throw new ConflictException(`role is held by ${holders} member(s), key(s) or invite(s)`);
            await tx.role.delete({ where: { id: roleId } });
        });
    }
}

/** The workspace the transaction is scoped to, read back from the policy rather than trusted from input. */
async function currentWorkspace(tx: WorkspaceClient): Promise<{ workspaceId: string }> {
    const workspace = await tx.workspace.findFirst({ select: { id: true } });
    if (!workspace) throw new Error('no workspace visible inside withWorkspace');
    return { workspaceId: workspace.id };
}

function view(role: {
    id: string;
    name: string;
    isSystem: boolean;
    recordScope: RecordScope;
    permissions: { capability: string }[];
}): RoleView {
    return {
        id: role.id,
        name: role.name,
        isSystem: role.isSystem,
        recordScope: role.recordScope,
        capabilities: [
            ...capabilitiesOf(
                role,
                role.permissions.map((p) => p.capability),
            ),
        ],
    };
}

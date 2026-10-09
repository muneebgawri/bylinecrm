import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { CAPABILITIES, SYSTEM_ROLES, isCapability, type Capability } from '@bylinecrm/shared';
import type { Prisma } from '@prisma/client';
import { RlsPrismaService, type WorkspaceClient } from '../infra/rls-prisma.service';

/** A role as the API returns it: the system admin role reports every capability. */
export interface RoleView {
    id: string;
    name: string;
    isSystem: boolean;
    capabilities: Capability[];
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

    /** The effective capabilities of one role, for the workspace guard. */
    capabilities(workspaceId: string, roleId: string): Promise<ReadonlySet<Capability> | null> {
        return this.rls.withWorkspace(workspaceId, async (tx) => {
            const role = await tx.role.findUnique({ where: { id: roleId }, include: { permissions: true } });
            return role
                ? capabilitiesOf(
                      role,
                      role.permissions.map((p) => p.capability),
                  )
                : null;
        });
    }

    create(name: string, capabilities: Capability[]): Promise<RoleView> {
        return this.rls.withWorkspace(async (tx) => {
            const { workspaceId } = await currentWorkspace(tx);
            try {
                const role = await tx.role.create({
                    data: {
                        workspaceId,
                        name,
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
     * Renames a role and/or replaces its capability list. The admin role's capabilities cannot
     * be edited (they are not stored); its name, and `member`'s, cannot change either.
     */
    update(
        roleId: string,
        patch: { name?: string | undefined; capabilities?: Capability[] | undefined },
    ): Promise<RoleView> {
        return this.rls.withWorkspace(async (tx) => {
            const role = await tx.role.findUnique({ where: { id: roleId } });
            if (!role) throw new NotFoundException('role not found');
            if (role.isSystem && patch.name !== undefined && patch.name !== role.name) {
                throw new UnprocessableEntityException('a system role keeps its name');
            }
            if (role.isSystem && role.name === SYSTEM_ROLES.admin && patch.capabilities !== undefined) {
                throw new UnprocessableEntityException('the admin role holds every capability');
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
                data: patch.name !== undefined ? { name: patch.name } : {},
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

function view(role: { id: string; name: string; isSystem: boolean; permissions: { capability: string }[] }): RoleView {
    return {
        id: role.id,
        name: role.name,
        isSystem: role.isSystem,
        capabilities: [
            ...capabilitiesOf(
                role,
                role.permissions.map((p) => p.capability),
            ),
        ],
    };
}

export function uniqueViolation(error: unknown): boolean {
    return (
        typeof error === 'object' && error !== null && (error as Prisma.PrismaClientKnownRequestError).code === 'P2002'
    );
}

import { UnprocessableEntityException } from '@nestjs/common';
import type { WorkspaceClient } from '../infra/rls-prisma.service';

/**
 * A write naming an owner names a member of this workspace. The lookup runs under the row-level
 * policies, so another workspace's member is simply not found — `422`, never a confirmation
 * that the id exists elsewhere.
 */
export async function assertOwnerIsMember(tx: WorkspaceClient, ownerId: string | null): Promise<void> {
    if (ownerId === null) return;
    const member = await tx.workspaceMember.findUnique({ where: { id: ownerId }, select: { id: true } });
    if (!member) throw new UnprocessableEntityException('owner is not a member of this workspace');
}

/** A person's company is a live company the caller can see. */
export async function assertCompanyExists(tx: WorkspaceClient, companyId: string | null): Promise<void> {
    if (companyId === null) return;
    const company = await tx.company.findFirst({ where: { id: companyId, deletedAt: null }, select: { id: true } });
    if (!company) throw new UnprocessableEntityException('company not found');
}

/**
 * Removes the keys whose value is `undefined`, so "not mentioned" never reaches Prisma as an
 * explicit `undefined` (which `exactOptionalPropertyTypes` rightly refuses).
 */
export function compact<T extends object>(value: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
    const out: Partial<Record<keyof T, unknown>> = {};
    for (const key of Object.keys(value) as (keyof T)[]) {
        if (value[key] !== undefined) out[key] = value[key];
    }
    return out as { [K in keyof T]?: Exclude<T[K], undefined> };
}

/**
 * A JSON column read back as the shape it was validated into on the way in. Every writer of
 * these columns goes through the DTOs, so the shape is known; this names that fact once.
 */
export function stored<T>(value: unknown): T {
    return value as T;
}

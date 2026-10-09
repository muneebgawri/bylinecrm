import { UnprocessableEntityException } from '@nestjs/common';
import type { WorkspaceClient } from '../infra/rls-prisma.service';

/** What a caller may send for an amount: minor units, and a currency that defaults to the workspace's. */
export type MoneyInput = { amountMinor: number; currency?: string | undefined };

/** The workspace's default currency, read under the policy that lets a workspace see itself. */
export async function defaultCurrency(tx: WorkspaceClient, workspaceId: string): Promise<string> {
    const workspace = await tx.workspace.findUnique({ where: { id: workspaceId }, select: { defaultCurrency: true } });
    if (!workspace) throw new Error('the current workspace is not readable');
    return workspace.defaultCurrency;
}

/**
 * The two columns an amount is stored in, from what the caller sent: `undefined` leaves both
 * alone, `null` clears both, a value sets both (the currency defaulting to the workspace's). One
 * rule for every money column; the database checks the pair stays consistent.
 */
export async function moneyColumns(
    tx: WorkspaceClient,
    workspaceId: string,
    input: MoneyInput | null | undefined,
): Promise<{ amountMinor?: bigint | null; currency?: string | null }> {
    if (input === undefined) return {};
    if (input === null) return { amountMinor: null, currency: null };
    return {
        amountMinor: BigInt(input.amountMinor),
        currency: input.currency ?? (await defaultCurrency(tx, workspaceId)),
    };
}

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

/** A deal's point of contact is a live person the caller can see. */
export async function assertPersonExists(tx: WorkspaceClient, personId: string | null): Promise<void> {
    if (personId === null) return;
    const person = await tx.person.findFirst({ where: { id: personId, deletedAt: null }, select: { id: true } });
    if (!person) throw new UnprocessableEntityException('person not found');
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

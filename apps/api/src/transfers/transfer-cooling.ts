import { TRANSFER_COOLING_DAYS_DEFAULT, type RecordObject, type TransferCoolingDetails } from '@bylinecrm/shared';
import { ApiException } from '../infra/errors/api-errors';
import type { WorkspaceClient } from '../infra/rls-prisma.service';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The transfer cooling period (OWN-1, owner decision 2, 2026-10-21): a record transferred away from a member
 * cannot go back to them — offered to them, or accepted by them — until the workspace's cooling days have passed
 * since that transfer. It stops a lead being passed back and forth. A holder of `record:transfer` (managers,
 * admins) is exempt, and so are their forced transfers; the caller decides that before asking here.
 *
 * A transfer counts when it completed (`accepted` or `forced`), named the member as `from`, and moved the record —
 * as its subject or as part of the unit that went with it (a company's people and open deals).
 */
export async function coolingDays(tx: WorkspaceClient): Promise<number> {
    const row = await tx.ownershipSettings.findFirst({ select: { transferCoolingDays: true } });
    return row?.transferCoolingDays ?? TRANSFER_COOLING_DAYS_DEFAULT;
}

/** When a member may take a record again after it left them at `leftAt`. */
export function coolingUnlocksAt(leftAt: Date, days: number): Date {
    return new Date(leftAt.getTime() + days * DAY_MS);
}

/** The `409` that says the record cannot go back to the member yet, and when it can. */
export function transferCooling(memberName: string | null, unlocksAt: Date, days: number): ApiException {
    const details: TransferCoolingDetails = { unlocksAt: unlocksAt.toISOString(), coolingDays: days };
    const day = unlocksAt.toISOString().slice(0, 10);
    return new ApiException(
        409,
        'conflict.transfer_cooling',
        memberName === null
            ? `This record was transferred away from you less than ${days} days ago. You can take it back from ${day}; a manager can move it sooner.`
            : `This record was transferred away from ${memberName} less than ${days} days ago. It can go back to them from ${day}; a manager can move it sooner.`,
        undefined,
        details,
    );
}

/**
 * Throws `conflict.transfer_cooling` when the record left `memberId` within the cooling period. `memberName` null
 * words the error to that member (they are the caller).
 */
export async function assertNotCooling(
    tx: WorkspaceClient,
    input: { object: RecordObject; recordId: string; memberId: string; memberName: string | null; now?: Date },
): Promise<void> {
    const days = await coolingDays(tx);
    if (days <= 0) return;
    const now = input.now ?? new Date();
    const since = new Date(now.getTime() - days * DAY_MS);
    const last = await tx.ownershipTransfer.findFirst({
        where: {
            fromMemberId: input.memberId,
            status: { in: ['accepted', 'forced'] },
            decidedAt: { gt: since },
            OR: [
                { object: input.object, recordId: input.recordId },
                { moved: { array_contains: [{ type: input.object, id: input.recordId }] } },
            ],
        },
        orderBy: { decidedAt: 'desc' },
        select: { decidedAt: true },
    });
    if (last?.decidedAt) throw transferCooling(input.memberName, coolingUnlocksAt(last.decidedAt, days), days);
}

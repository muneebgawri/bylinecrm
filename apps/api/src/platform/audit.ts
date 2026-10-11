import type { PlatformEvent, PlatformEventType } from '@bylinecrm/shared';
import type { Prisma } from '@prisma/client';

/**
 * Appends one row to `platform_audit` inside the caller's owner-client transaction, so the record
 * and the change it records commit or roll back together, and returns the event to publish once
 * the transaction has committed. The subject names ids and addresses, never a token.
 */
export async function recordPlatformAction(
    tx: Prisma.TransactionClient,
    type: PlatformEventType,
    actorUserId: string | null,
    subject: PlatformEvent['subject'],
): Promise<PlatformEvent> {
    const row = await tx.platformAudit.create({ data: { action: type, actorUserId, subject } });
    return { type, actorUserId, occurredAt: row.occurredAt.toISOString(), subject };
}

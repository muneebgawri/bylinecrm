import type { PlatformEvent, PlatformEventType } from '@bylinecrm/shared';
import type { Prisma } from '@prisma/client';

/**
 * Appends one row to `platform_audit` inside the caller's owner-client transaction, so the record
 * and the change it records commit or roll back together. The audit is the platform's event record:
 * operator-level actions belong to no workspace, so they are not domain events and no workspace
 * consumer takes them (P1-6). The subject names ids and addresses, never a token.
 */
export async function recordPlatformAction(
    tx: Prisma.TransactionClient,
    type: PlatformEventType,
    actorUserId: string | null,
    subject: PlatformEvent['subject'],
): Promise<void> {
    await tx.platformAudit.create({ data: { action: type, actorUserId, subject } });
}

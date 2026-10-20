import type { MailboxPause } from '@bylinecrm/shared';
import { Prisma } from '@prisma/client';
import type { DomainEvents } from '../events/domain-events.service';
import type { WorkspaceClient } from '../infra/rls-prisma.service';

/**
 * Pauses a mailbox (REP-2) the way P3-2 pauses a pool mailbox: the row (the caller has it locked or does not
 * care about a race — a paused mailbox keeps its first reason) and `mailbox.paused`. A paused pool mailbox sends
 * nothing; a paused personal mailbox still sends replies.
 */
export async function pauseMailbox(
    tx: WorkspaceClient,
    events: DomainEvents,
    workspaceId: string,
    mailboxId: string,
    pause: MailboxPause,
): Promise<boolean> {
    const changed = await tx.mailbox.updateMany({
        where: { id: mailboxId, pausedAt: null },
        data: { pausedAt: new Date(pause.at), pauseReason: pause as unknown as Prisma.InputJsonValue },
    });
    if (changed.count === 0) return false;
    await events.record(tx, {
        type: 'mailbox.paused',
        object: 'mailbox',
        workspaceId,
        actor: { kind: 'system', id: null },
        occurredAt: pause.at,
        recordId: mailboxId,
        pause,
    });
    return true;
}

/** Basis points as a percent, `30` → `0.3%`. */
export function bpsText(bps: number): string {
    return `${(bps / 100).toFixed(2).replace(/\.?0+$/, '')}%`;
}

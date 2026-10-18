import { DEFAULT_DKIM_SELECTOR, type MailboxPurpose } from '@bylinecrm/shared';
import type { WorkspaceClient } from '../infra/rls-prisma.service';

/** The sending domain of an address: what follows the @, lower case. */
export function sendingDomainOf(address: string): string {
    return address.slice(address.lastIndexOf('@') + 1).toLowerCase();
}

/**
 * A mailbox just connected (P3-2, #190), inside the connection's transaction: its sending domain is
 * known, due for its first DNS check at once, whatever the mailbox is for — a personal mailbox's
 * domain is monitored, a pool mailbox's is gated (until its check passes, nothing sends from it).
 * A pool mailbox's warm-up starts now unless it started before (reconnecting never restarts it).
 */
export async function enrolMailbox(
    tx: WorkspaceClient,
    mailbox: { id: string; workspaceId: string; email: string; purpose: MailboxPurpose; warmupStartedAt: Date | null },
): Promise<void> {
    if (mailbox.purpose === 'pool' && !mailbox.warmupStartedAt) {
        await tx.mailbox.update({ where: { id: mailbox.id }, data: { warmupStartedAt: new Date() } });
    }
    await tx.sendingDomain.createMany({
        data: [
            {
                workspaceId: mailbox.workspaceId,
                domain: sendingDomainOf(mailbox.email),
                dkimSelector: DEFAULT_DKIM_SELECTOR,
            },
        ],
        skipDuplicates: true,
    });
}

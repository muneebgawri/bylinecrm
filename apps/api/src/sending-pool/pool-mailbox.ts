import { DEFAULT_DKIM_SELECTOR } from '@bylinecrm/shared';
import type { WorkspaceClient } from '../infra/rls-prisma.service';

/** The sending domain of an address: what follows the @, lower case. */
export function sendingDomainOf(address: string): string {
    return address.slice(address.lastIndexOf('@') + 1).toLowerCase();
}

/**
 * A mailbox connected as a pool mailbox (P3-2), inside the connection's transaction: its warm-up
 * starts now unless it started before (reconnecting never restarts it), and its sending domain is
 * known, due for its first DNS check at once — until that check passes, nothing sends from it.
 */
export async function enrolPoolMailbox(
    tx: WorkspaceClient,
    mailbox: { id: string; workspaceId: string; email: string; warmupStartedAt: Date | null },
): Promise<void> {
    if (!mailbox.warmupStartedAt) {
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

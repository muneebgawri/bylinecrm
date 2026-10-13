import type { Prisma } from '@prisma/client';
import type { PostmasterConnectionView } from '@bylinecrm/shared';
import type { WorkspaceClient } from '../infra/rls-prisma.service';

type ConnectionRow = Prisma.PostmasterConnectionGetPayload<object>;

/**
 * The workspace's Postmaster Tools connection (#129), as plain functions so the connect flow
 * (mail accounts, which finishes the OAuth callback) and the pool (which reads and removes it)
 * share one row without either module depending on the other's services.
 */

/** Stores the grant a callback just finished: one per workspace, so connecting again replaces it. */
export async function storePostmasterConnection(
    tx: WorkspaceClient,
    input: {
        workspaceId: string;
        email: string;
        grantedScopes: string[];
        refreshTokenCiphertext: string;
        accessTokenCiphertext: string;
        accessExpiresAt: Date;
        connectedByMemberId: string;
    },
): Promise<void> {
    const now = new Date();
    const { workspaceId, ...rest } = input;
    await tx.postmasterConnection.upsert({
        where: { workspaceId },
        create: { workspaceId, ...rest, status: 'connected', lastError: null, connectedAt: now },
        update: { ...rest, status: 'connected', lastError: null, connectedAt: now },
    });
}

/** The connection as the pool reports it: never a token. */
export function postmasterConnectionView(row: ConnectionRow): PostmasterConnectionView {
    return {
        email: row.email,
        status: row.status,
        connectedAt: row.connectedAt.toISOString(),
        lastError: row.lastError,
    };
}

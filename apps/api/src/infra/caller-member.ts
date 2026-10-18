import { ApiException } from './errors/api-errors';
import type { WorkspaceClient } from './rls-prisma.service';
import type { WorkspaceRunContext } from './workspace-context';

/** The member a caller acts as: the signed-in member, else the member whose API key it is; null for neither. */
export async function callerMemberId(tx: WorkspaceClient, context: WorkspaceRunContext): Promise<string | null> {
    if (context.memberId) return context.memberId;
    if (context.apiKeyId) {
        const key = await tx.apiKey.findUniqueOrThrow({
            where: { id: context.apiKeyId },
            select: { createdById: true },
        });
        return key.createdById;
    }
    return null;
}

/** The caller's member, or a 403: only a member, or a member's API key, may do what asks for one. */
export async function requireCallerMember(tx: WorkspaceClient, context: WorkspaceRunContext): Promise<string> {
    const member = await callerMemberId(tx, context);
    if (!member) throw new ApiException(403, 'forbidden', 'only a member or a member’s API key may do this');
    return member;
}

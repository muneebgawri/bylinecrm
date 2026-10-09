import type { Actor } from '@bylinecrm/shared';
import type { WorkspaceRunContext } from '../infra/workspace-context';

/** Who is acting, for `created_by` and for events: the member, else the key, else the system. */
export function actorOf(context: WorkspaceRunContext): Actor {
    if (context.memberId) return { kind: 'member', id: context.memberId };
    if (context.apiKeyId) return { kind: 'api_key', id: context.apiKeyId };
    return { kind: 'system', id: null };
}

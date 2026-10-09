import type { Capability } from '@bylinecrm/shared';

/**
 * The API's response and request shapes as the web app reads them. These mirror the P0-3
 * services' views by hand because the OpenAPI document is not yet committed on `main` (P1-1a's
 * contract freeze); when it is, this file is replaced by `openapi-typescript` output and the
 * endpoint functions keep their signatures. Until then, a change on the API side that is not
 * mirrored here is caught by the browser walk, not the compiler — which is why the swap is owed.
 *
 * Dates arrive as ISO strings over the wire; they are typed as such here, never as `Date`.
 */

export interface UserView {
    id: string;
    email: string;
    emailVerified: boolean;
}

export interface WorkspaceView {
    id: string;
    slug: string;
    name: string;
}

export interface RoleView {
    id: string;
    name: string;
    isSystem: boolean;
    capabilities: Capability[];
}

export interface MemberView {
    id: string;
    userId: string;
    email: string;
    roleId: string;
    roleName: string;
    createdAt: string;
}

export interface ApiKeyView {
    id: string;
    name: string;
    prefix: string;
    roleId: string;
    createdAt: string;
    lastUsedAt: string | null;
    revokedAt: string | null;
}

export interface InviteView {
    id: string;
    email: string;
    roleId: string;
    expiresAt: string;
    acceptedAt: string | null;
}

/**
 * The caller's standing in one workspace: `GET /w/:workspaceId/me`, gated by the workspace guard
 * only (agreed with P1-1a, which ships the route with the OpenAPI freeze). A person has a
 * `memberId` and `userId`; an API-key principal has neither and carries `apiKeyId` instead.
 * `recordScope: 'own'` is the account-manager rule — reads are limited to records they own.
 */
export interface MembershipSummary {
    memberId: string | null;
    userId: string | null;
    apiKeyId?: string | null;
    roleId: string;
    roleName: string;
    recordScope: 'all' | 'own';
    capabilities: readonly Capability[];
}

export interface SignupInput {
    email: string;
    password: string;
    workspaceName: string;
}

export interface LoginInput {
    email: string;
    password: string;
}

export interface CreateRoleInput {
    name: string;
    capabilities: Capability[];
}

export interface UpdateRoleInput {
    name?: string | undefined;
    capabilities?: Capability[] | undefined;
}

export interface CreateApiKeyInput {
    name: string;
    roleId: string;
}

export interface CreateInviteInput {
    email: string;
    roleId: string;
}

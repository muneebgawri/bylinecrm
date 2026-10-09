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
 * The signed-in member's standing in one workspace: what `useCan` reads. No current endpoint
 * returns it (see the P1-UI-1 design note, "Owed by the API"); the type is the contract the web
 * app needs and the provider that fills it is the swap point.
 */
export interface MembershipSummary {
    workspaceId: string;
    memberId: string;
    roleId: string;
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

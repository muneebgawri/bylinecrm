import type {
    Capability,
    FilterGroup,
    Money,
    RecordObject,
    SavedView,
    StageColour,
    StageKind,
    StageRuleEvent,
} from '@bylinecrm/shared';

export type { SavedView };

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

/** A cursor page, as every list endpoint returns it (P1-1a). */
export interface Page<T> {
    items: T[];
    nextCursor: string | null;
}

/** `GET /w/:id/members/summary` — names for pickers; no emails, no roles (P1-1b). */
export interface MemberSummaryView {
    memberId: string;
    name: string | null;
}

// ---- Pipelines and deals (P1-2) ------------------------------------------------------------

export interface StageView {
    id: string;
    pipelineId: string;
    name: string;
    position: number;
    probability: number;
    kind: StageKind;
    daysThreshold: number | null;
    /** A semantic token name; the UI maps it to a tone, never to a hue. */
    colour: StageColour;
}

export interface PipelineView {
    id: string;
    name: string;
    isDefault: boolean;
    position: number;
    stages: StageView[];
    createdAt: string;
    updatedAt: string;
}

export interface RuleView {
    id: string;
    pipelineId: string;
    event: StageRuleEvent;
    toStageId: string;
    allowBackward: boolean;
    enabled: boolean;
}

export interface OpportunityView {
    id: string;
    name: string;
    pipelineId: string;
    stageId: string;
    stageEnteredAt: string;
    /** Whole days, computed by the API from the stage history — never stored, never recomputed here. */
    daysInStage: number;
    closedAt: string | null;
    lostReason: string | null;
    amount: Money | null;
    currency: string;
    /** `YYYY-MM-DD` or null. */
    closeDate: string | null;
    probability: number | null;
    position: number;
    ownerId: string | null;
    pointOfContactId: string | null;
    companyId: string | null;
    custom: Record<string, unknown>;
    deletedAt: string | null;
    createdAt: string;
    updatedAt: string;
}

export interface BoardColumn {
    stage: StageView;
    /** Deals in this stage under the current query and the caller's scope — not the whole stage. */
    count: number;
    /** Exact sums per currency, from the API; the UI formats and never adds them up itself. */
    amountMinorByCurrency: Record<string, number>;
    deals: OpportunityView[];
    /** The column carries at most `BOARD_STAGE_LIMIT`; true when the stage holds more. */
    hasMore: boolean;
}

export interface BoardView {
    pipeline: PipelineView;
    columns: BoardColumn[];
}

/**
 * The board and the deal list take the same query (P1-4): a saved view's id, an inline filter
 * (base64url JSON, which replaces the view's filter whole), a sort, and a search.
 */
export interface BoardQuery {
    view?: string | undefined;
    filter?: string | undefined;
    sort?: string | undefined;
    q?: string | undefined;
}

export interface CreateViewInput {
    object: RecordObject;
    name: string;
    filter?: FilterGroup | null | undefined;
    sorts?: SavedView['sorts'] | undefined;
    isShared?: boolean | undefined;
}

export interface UpdateViewInput {
    name?: string | undefined;
    filter?: FilterGroup | null | undefined;
    sorts?: SavedView['sorts'] | undefined;
    isShared?: boolean | undefined;
}

export interface MoveDealInput {
    stageId: string;
    /** Required by the API when `stageId` is a won or lost stage. */
    close?: { wonAmount?: Money | undefined; lostReason?: string | undefined } | undefined;
}

export interface MoveResult {
    deal: OpportunityView;
    /** Set after a backward move: the enabled rules that may move the deal forward again. */
    rulesThatMayMoveItForward: RuleView[];
}

export interface CreateOpportunityInput {
    name: string;
    pipelineId?: string | undefined;
    stageId?: string | undefined;
    amount?: Money | null | undefined;
    closeDate?: string | null | undefined;
    companyId?: string | null | undefined;
    ownerId?: string | null | undefined;
    pointOfContactId?: string | null | undefined;
}

export interface UpdateOpportunityInput {
    ownerId?: string | null | undefined;
}

/** The slice of `CompanyView` a picker needs. */
export interface CompanySummary {
    id: string;
    name: string;
    domain: string | null;
}

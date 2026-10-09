import type {
    Actor,
    Address,
    Capability,
    CustomFieldType,
    Emails,
    FilterGroup,
    LinkedObject,
    Links,
    Money,
    Phones,
    RecordObject,
    RecordTarget,
    RichText,
    SavedView,
    StageColour,
    StageHistoryReason,
    StageKind,
    StageRuleEvent,
    TaskStatus,
    TimelineActor,
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

// ─────────────────────────────────────────────────────────────────────────────
// Records (P1-1a/P1-1b/P1-3): the shapes the record pages read. Dates are ISO strings.
// ─────────────────────────────────────────────────────────────────────────────

/** A cursor page from any list endpoint. */
export interface Page<T> {
    items: T[];
    nextCursor: string | null;
}

export interface PersonView {
    id: string;
    nameFirst: string;
    nameLast: string;
    emails: Emails;
    phones: Phones;
    jobTitle: string | null;
    city: string | null;
    links: Links;
    avatarUrl: string | null;
    position: number;
    companyId: string | null;
    ownerId: string | null;
    createdBy: Actor;
    custom: Record<string, unknown>;
    deletedAt: string | null;
    createdAt: string;
    updatedAt: string;
}

export interface CompanyView {
    id: string;
    name: string;
    domain: string | null;
    employeeCount: number | null;
    arr: Money | null;
    address: Address;
    links: Links;
    icp: boolean;
    position: number;
    ownerId: string | null;
    createdBy: Actor;
    custom: Record<string, unknown>;
    deletedAt: string | null;
    createdAt: string;
    updatedAt: string;
}

/** A deal (P1-1b + P1-2): its place in a pipeline is part of the record, computed from stage history. */
export interface OpportunityView {
    id: string;
    name: string;
    pipelineId: string;
    stageId: string;
    /** When the deal entered its current stage (the latest history row). */
    stageEnteredAt: string;
    /** Whole days since `stageEnteredAt`, computed by the API at read time. */
    daysInStage: number;
    /** Set while the deal is in a won or lost stage. */
    closedAt: string | null;
    lostReason: string | null;
    amount: Money | null;
    currency: string;
    closeDate: string | null;
    probability: number | null;
    position: number;
    ownerId: string | null;
    pointOfContactId: string | null;
    companyId: string | null;
    createdBy: Actor;
    custom: Record<string, unknown>;
    deletedAt: string | null;
    createdAt: string;
    updatedAt: string;
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

export interface StageView {
    id: string;
    pipelineId: string;
    name: string;
    position: number;
    probability: number;
    kind: StageKind;
    daysThreshold: number | null;
    colour: StageColour;
}

export interface StageHistoryEntry {
    id: string;
    fromStageId: string | null;
    toStageId: string;
    enteredAt: string;
    actor: TimelineActor;
    reason: StageHistoryReason;
}

export interface RuleView {
    id: string;
    pipelineId: string;
    event: StageRuleEvent;
    toStageId: string;
    allowBackward: boolean;
    enabled: boolean;
}

/** What a move returns: the deal, and the rules that may move it forward again after a backward move. */
export interface MoveResult {
    deal: OpportunityView;
    rulesThatMayMoveItForward: RuleView[];
}

export interface MoveDealInput {
    stageId: string;
    close?: { wonAmount?: Money; lostReason?: string };
}

export interface NoteView {
    id: string;
    title: string;
    body: RichText;
    bodyText: string;
    targets: RecordTarget[];
    authorId: string | null;
    createdBy: Actor;
    deletedAt: string | null;
    createdAt: string;
    updatedAt: string;
}

export interface TaskView {
    id: string;
    title: string;
    body: RichText;
    bodyText: string;
    status: TaskStatus;
    dueAt: string | null;
    assigneeId: string | null;
    completedAt: string | null;
    targets: RecordTarget[];
    createdBy: Actor;
    deletedAt: string | null;
    createdAt: string;
    updatedAt: string;
}

export interface AttachmentView {
    id: string;
    name: string;
    mime: string;
    sizeBytes: number;
    target: RecordTarget;
    authorId: string | null;
    createdBy: Actor;
    deletedAt: string | null;
    createdAt: string;
    updatedAt: string;
}

export interface TimelineActivityView {
    id: string;
    target: RecordTarget;
    kind: string;
    happenedAt: string;
    actor: TimelineActor;
    properties: Record<string, unknown>;
    linked: { type: LinkedObject; id: string } | null;
    createdAt: string;
}

export interface CustomFieldView {
    id: string;
    object: RecordObject;
    key: string;
    label: string;
    type: CustomFieldType;
    options: string[];
    required: boolean;
    position: number;
    archivedAt: string | null;
    createdAt: string;
    updatedAt: string;
}

/** `GET /w/:id/members/summary`: enough to name a member in a picker, nothing more. */
export interface MemberSummaryView {
    memberId: string;
    name: string | null;
}

/** The writable part of a person; every field optional, as the API's patch is. */
export type PersonInput = Partial<
    Pick<
        PersonView,
        | 'nameFirst'
        | 'nameLast'
        | 'emails'
        | 'phones'
        | 'jobTitle'
        | 'city'
        | 'links'
        | 'avatarUrl'
        | 'position'
        | 'companyId'
        | 'ownerId'
        | 'custom'
    >
>;
export type CompanyInput = Partial<
    Pick<
        CompanyView,
        'name' | 'domain' | 'employeeCount' | 'arr' | 'address' | 'links' | 'icp' | 'position' | 'ownerId' | 'custom'
    >
>;
export type OpportunityInput = Partial<
    Pick<
        OpportunityView,
        | 'name'
        | 'amount'
        | 'closeDate'
        | 'probability'
        | 'position'
        | 'ownerId'
        | 'pointOfContactId'
        | 'companyId'
        | 'custom'
    >
>;
export interface NoteInput {
    title?: string | undefined;
    body?: RichText | undefined;
    targets?: RecordTarget[] | undefined;
}
export interface TaskInput {
    title?: string | undefined;
    body?: RichText | undefined;
    status?: TaskStatus | undefined;
    dueAt?: string | null | undefined;
    assigneeId?: string | null | undefined;
    targets?: RecordTarget[] | undefined;
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

// ---- The pipeline board and saved views (P1-2, P1-4; P1-UI-4) ------------------------------

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

/** Create takes where the deal starts; a patch cannot change the stage (that is a move). */
export type OpportunityCreateInput = OpportunityInput & {
    name: string;
    pipelineId?: string | undefined;
    stageId?: string | undefined;
};

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

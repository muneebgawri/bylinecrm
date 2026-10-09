import type { components, paths } from './schema.gen';

/**
 * The API's request and response shapes, as the web app names them. Every type here is derived
 * from `schema.gen.ts`, which `openapi-typescript` generates from `apps/api/openapi.json` before
 * every typecheck and build (P1-UI-5) — so a change to the API's contract that breaks a call site
 * fails the web's typecheck, not a browser walk. Nothing in this file is written by hand except
 * the names: a readable alias where a call site needs one.
 *
 * Dates arrive as ISO strings over the wire and are typed as such, never as `Date`.
 */
type Schemas = components['schemas'];

// ---- Account, workspaces, membership (P0-3) ------------------------------------------------
export type UserView = Schemas['User'];
export type WorkspaceView = Schemas['Workspace'];
export type RoleView = Schemas['Role'];
export type MemberView = Schemas['Member'];
export type ApiKeyView = Schemas['ApiKey'];
export type InviteView = Schemas['Invite'];
/** The caller's standing in one workspace: `GET /w/:workspaceId/me`. */
export type MembershipSummary = Schemas['Standing'];
export type MemberSummaryView = Schemas['MemberSummary'];

export type SignupInput = Schemas['SignupDto'];
export type LoginInput = Schemas['LoginDto'];
export type CreateRoleInput = Schemas['CreateRoleDto'];
export type UpdateRoleInput = Schemas['UpdateRoleDto'];
export type CreateApiKeyInput = Schemas['CreateApiKeyDto'];
export type CreateInviteInput = Schemas['CreateInviteDto'];

// ---- Records (P1-1a/P1-1b/P1-3/P1-4a) -------------------------------------------------------
export type PersonView = Schemas['Person'];
export type CompanyView = Schemas['Company'];
export type OpportunityView = Schemas['Opportunity'];
export type NoteView = Schemas['Note'];
export type TaskView = Schemas['Task'];
export type AttachmentView = Schemas['Attachment'];
export type TimelineActivityView = Schemas['TimelineActivity'];
export type CustomFieldView = Schemas['CustomField'];
/** A related record named on a row; `null` on the row when none, trashed or not visible. */
export type RecordSummaryView = Schemas['RecordSummary'];

/** A page of a record list: the cursor page plus the size of the whole filtered, scoped set. */
export type PersonPage = Schemas['PersonPage'];
export type CompanyPage = Schemas['CompanyPage'];
export type OpportunityPage = Schemas['OpportunityPage'];
export type NotePage = Schemas['NotePage'];
export type TaskPage = Schemas['TaskPage'];
export type TimelinePage = Schemas['TimelinePage'];

export type PersonInput = Schemas['UpdatePersonDto'];
export type PersonCreateInput = Schemas['CreatePersonDto'];
export type CompanyInput = Schemas['UpdateCompanyDto'];
export type CompanyCreateInput = Schemas['CreateCompanyDto'];
export type OpportunityInput = Schemas['UpdateOpportunityDto'];
/** Create takes where the deal starts; a patch cannot change the stage (that is a move). */
export type OpportunityCreateInput = Schemas['CreateOpportunityDto'];
export type NoteInput = Schemas['UpdateNoteDto'];
export type NoteCreateInput = Schemas['CreateNoteDto'];
export type TaskInput = Schemas['UpdateTaskDto'];
export type TaskCreateInput = Schemas['CreateTaskDto'];

/** `POST …/bulk`: one action over ids or over a list's selection, never both. */
export type BulkInput = Schemas['BulkBodyDto'];
export type BulkAction = BulkInput['action'];
export type BulkResultView = Schemas['BulkResult'];
/** One record's outcome, in the order named: refused rows read `not_found` whatever the reason. */
export type BulkRowResult = BulkResultView['results'][number];

// ---- Pipelines, the board, saved views and search (P1-2, P1-4) -------------------------------
export type PipelineView = Schemas['Pipeline'];
export type StageView = Schemas['Stage'];
export type StageHistoryEntry = Schemas['StageHistoryEntry'];
export type RuleView = Schemas['StageRule'];
/** What a move returns: the deal, and the rules that may move it forward again after a backward move. */
export type MoveResult = Schemas['MoveResult'];
export type MoveDealInput = Schemas['MoveDealDto'];
export type BoardView = Schemas['Board'];
export type BoardColumn = Schemas['BoardColumn'];
/**
 * The board and the deal list take the same query: a saved view's id, an inline filter (base64url
 * JSON, which replaces the view's filter whole), a sort, and a search.
 */
export type BoardQuery = NonNullable<
    paths['/api/w/{workspaceId}/pipelines/{pipelineId}/board']['get']['parameters']['query']
>;

export type SavedView = Schemas['SavedView'];
export type CreateViewInput = Schemas['CreateViewDto'];
export type UpdateViewInput = Schemas['UpdateViewDto'];
export type SearchResults = Schemas['SearchResults'];

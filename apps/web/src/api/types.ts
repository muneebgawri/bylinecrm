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

type OptionalKeys<T> = { [K in keyof T]-?: object extends Pick<T, K> ? K : never }[keyof T];
/**
 * What the app may send for a request shape: the generated type, except an optional key may also
 * be present with `undefined`. That is exactly what reaches the API — the client serialises bodies
 * with `JSON.stringify` and builds query strings without undefined values, so `{ a: undefined }`
 * and `{}` are the same request; arrays are read-only because the client only reads them. Responses
 * are never loosened: what the API returns is read exactly.
 */
export type Loose<T> = T extends (infer U)[]
    ? readonly Loose<U>[]
    : T extends object
      ? { [K in Exclude<keyof T, OptionalKeys<T>>]: Loose<T[K]> } & { [K in OptionalKeys<T>]?: Loose<T[K]> | undefined }
      : T;

// ---- Account, workspaces, membership (P0-3) ------------------------------------------------
export type UserView = Schemas['User'];
export type ProfileView = Schemas['Profile'];
export type WorkspaceView = Schemas['Workspace'];
export type RoleView = Schemas['Role'];
export type MemberView = Schemas['Member'];
export type ApiKeyView = Schemas['ApiKey'];
export type InviteView = Schemas['Invite'];
/** The caller's standing in one workspace: `GET /w/:workspaceId/me`. */
export type MembershipSummary = Schemas['Standing'];
export type MemberSummaryView = Schemas['MemberSummary'];

export type SignupInput = Loose<Schemas['SignupDto']>;
export type LoginInput = Loose<Schemas['LoginDto']>;
export type CreateRoleInput = Loose<Schemas['CreateRoleDto']>;
export type UpdateRoleInput = Loose<Schemas['UpdateRoleDto']>;
export type CreateApiKeyInput = Loose<Schemas['CreateApiKeyDto']>;
export type CreateInviteInput = Loose<Schemas['CreateInviteDto']>;

// ---- Records (P1-1a/P1-1b/P1-3/P1-4a) -------------------------------------------------------
export type PersonView = Schemas['Person'];
export type CompanyView = Schemas['Company'];
export type OpportunityView = Schemas['Opportunity'];
export type NoteView = Schemas['Note'];
export type TaskView = Schemas['Task'];
export type AttachmentView = Schemas['Attachment'];
export type TimelineActivityView = Schemas['TimelineActivity'];
export type CustomFieldView = Schemas['CustomField'];
export type CreateCustomFieldInput = Loose<Schemas['CreateCustomFieldDto']>;
export type UpdateCustomFieldInput = Loose<Schemas['UpdateCustomFieldDto']>;
/** A related record named on a row; `null` on the row when none, trashed or not visible. */
export type RecordSummaryView = Schemas['RecordSummary'];

/** A page of a record list: the cursor page plus the size of the whole filtered, scoped set. */
export type PersonPage = Schemas['PersonPage'];
export type CompanyPage = Schemas['CompanyPage'];
export type OpportunityPage = Schemas['OpportunityPage'];
export type NotePage = Schemas['NotePage'];
export type TaskPage = Schemas['TaskPage'];
export type TimelinePage = Schemas['TimelinePage'];

export type PersonInput = Loose<Schemas['UpdatePersonDto']>;
export type PersonCreateInput = Loose<Schemas['CreatePersonDto']>;
export type CompanyInput = Loose<Schemas['UpdateCompanyDto']>;
export type CompanyCreateInput = Loose<Schemas['CreateCompanyDto']>;
export type OpportunityInput = Loose<Schemas['UpdateOpportunityDto']>;
/** Create takes where the deal starts; a patch cannot change the stage (that is a move). */
export type OpportunityCreateInput = Loose<Schemas['CreateOpportunityDto']>;
export type NoteInput = Loose<Schemas['UpdateNoteDto']>;
export type NoteCreateInput = Loose<Schemas['CreateNoteDto']>;
export type TaskInput = Loose<Schemas['UpdateTaskDto']>;
export type TaskCreateInput = Loose<Schemas['CreateTaskDto']>;

/** `POST …/bulk`: one action over ids or over a list's selection, never both. */
export type BulkInput = Loose<Schemas['BulkBodyDto']>;
export type BulkAction = Schemas['BulkBodyDto']['action'];
export type BulkResultView = Schemas['BulkResult'];
/** One record's outcome, in the order named: refused rows read `not_found` whatever the reason. */
export type BulkRowResult = BulkResultView['results'][number];

// ---- Pipelines, the board, saved views and search (P1-2, P1-4) -------------------------------
export type PipelineView = Schemas['Pipeline'];
export type StageView = Schemas['Stage'];
export type StageHistoryEntry = Schemas['StageHistoryEntry'];
export type RuleView = Schemas['StageRule'];
export type CreatePipelineInput = Loose<Schemas['CreatePipelineDto']>;
export type UpdatePipelineInput = Loose<Schemas['UpdatePipelineDto']>;
export type CreateStageInput = Loose<Schemas['CreateStageDto']>;
export type UpdateStageInput = Loose<Schemas['UpdateStageDto']>;
export type CreateRuleInput = Loose<Schemas['CreateRuleDto']>;
export type UpdateRuleInput = Loose<Schemas['UpdateRuleDto']>;
/** What a move returns: the deal, and the rules that may move it forward again after a backward move. */
export type MoveResult = Schemas['MoveResult'];
export type MoveDealInput = Loose<Schemas['MoveDealDto']>;
export type BoardView = Schemas['Board'];
export type BoardColumn = Schemas['BoardColumn'];
/**
 * The board and the deal list take the same query: a saved view's id, an inline filter (base64url
 * JSON, which replaces the view's filter whole), a sort, and a search.
 */
export type BoardQuery = Loose<
    NonNullable<paths['/api/w/{workspaceId}/pipelines/{pipelineId}/board']['get']['parameters']['query']>
>;

export type SavedView = Schemas['SavedView'];
export type CreateViewInput = Loose<Schemas['CreateViewDto']>;
export type UpdateViewInput = Loose<Schemas['UpdateViewDto']>;
export type SearchResults = Schemas['SearchResults'];

// ---- Templates and workspace mail settings (P2-4) --------------------------------------------
export type EmailTemplateView = Schemas['EmailTemplate'];
export type EmailTemplatePage = Schemas['EmailTemplatePage'];
export type TemplateVariablesView = Schemas['TemplateVariables'];
/** One variable the editor offers: a standard one, or one of the workspace's custom fields. */
export type TemplateVariableView = Schemas['TemplateVariable'] | TemplateVariablesView['custom'][number];
/** A preview: `missing` names every variable with no value; `sendable` is false whenever it is not empty. */
export type RenderedEmailView = Schemas['RenderedEmail'];
export type MailSettingsView = Schemas['MailSettings'];
export type PostalAddressView = Schemas['PostalAddress'];
export type CreateTemplateInput = Loose<Schemas['CreateTemplateDto']>;
/** A patch names the version it edited (`version`); a stale one is answered `409 conflict`. */
export type UpdateTemplateInput = Loose<Schemas['UpdateTemplateDto']>;
export type PreviewTemplateInput = Loose<Schemas['PreviewTemplateDto']>;
export type PutMailSettingsInput = Loose<Schemas['PutMailSettingsDto']>;
export type TemplateListQuery = Loose<
    NonNullable<paths['/api/w/{workspaceId}/templates']['get']['parameters']['query']>
>;

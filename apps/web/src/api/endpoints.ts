import type { FilterGroup, RecordObject, RecordTarget, TaskStatus } from '@bylinecrm/shared';
import { API_BASE, request, requestFile } from './client';
import type {
    AuthProvidersView,
    CreatedPlatformWorkspaceView,
    CreatePlatformWorkspaceInput,
    CreateSignupInviteInput,
    InvitePreviewView,
    PlatformAccessView,
    PlatformInviteView,
    PlatformWorkspaceView,
    ApiKeyView,
    AttachmentView,
    BlocklistEntryCreatedView,
    BlocklistEntryView,
    BoardQuery,
    BoardView,
    BulkInput,
    BulkResultView,
    CompanyInput,
    CompanyPage,
    CompanyView,
    ConnectMailboxInput,
    CreateApiKeyInput,
    CreateBlocklistEntryInput,
    CreateCustomFieldInput,
    CreateInviteInput,
    CreatePipelineInput,
    CreateRoleInput,
    CreateRuleInput,
    CreateStageInput,
    CreateTemplateInput,
    CreateViewInput,
    CustomFieldView,
    EmailTemplatePage,
    EmailTemplateView,
    GoogleOAuthClientStatusView,
    GoogleOAuthClientView,
    InviteView,
    LoginInput,
    MailboxCheckView,
    MailboxConnectStartView,
    MailboxDisconnectedView,
    MailboxSyncTriggeredView,
    MailboxSyncView,
    MailboxView,
    MailOutboundView,
    MailScheduledPage,
    MailSendAcceptedView,
    MailThreadView,
    MailSettingsView,
    MembershipSummary,
    MemberSummaryView,
    MemberView,
    MoveDealInput,
    MoveResult,
    NoteCreateInput,
    NoteInput,
    NotePage,
    NoteView,
    OpportunityCreateInput,
    OpportunityInput,
    OpportunityPage,
    OpportunityView,
    PersonInput,
    PersonPage,
    PersonView,
    PipelineView,
    PreviewTemplateInput,
    ProfileView,
    PutMailSettingsInput,
    PutOAuthClientInput,
    RenderedEmailView,
    RescheduleMailInput,
    RoleView,
    RuleView,
    SavedView,
    SearchResults,
    SendMailInput,
    SignupInput,
    StageHistoryEntry,
    TaskCreateInput,
    TaskInput,
    TaskPage,
    TaskView,
    TemplateListQuery,
    TemplateVariablesView,
    TimelinePage,
    UpdateCustomFieldInput,
    UpdatePipelineInput,
    UpdateRoleInput,
    UpdateRuleInput,
    UpdateStageInput,
    UpdateTemplateInput,
    UpdateViewInput,
    UserView,
    WorkspaceView,
} from './types';

/** `person:<uuid>` — how a target travels in a query string; the API parses the same spelling. */
export function targetParam(target: RecordTarget): string {
    return `${target.type}:${target.id}`;
}

/** Builds `?a=b&c=d` from the defined values only. */
function query(params: Record<string, string | number | undefined>): string {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) if (value !== undefined) search.set(key, String(value));
    const text = search.toString();
    return text ? `?${text}` : '';
}

/** A type alias (not an interface) so it satisfies `query`'s index signature. */
export type ListParams = {
    cursor?: string | undefined;
    limit?: number | undefined;
    sort?: string | undefined;
    q?: string | undefined;
    /** The P1-4 filter grammar, already encoded (`lib/filterParam.ts`); the API decodes it. */
    filter?: string | undefined;
    /** A saved view's id: its filter and sort are the defaults the inline ones replace. */
    view?: string | undefined;
};

/** What an export takes: the list's query and the columns to write, in order. */
export type ExportParams = Omit<ListParams, 'cursor' | 'limit'> & { columns?: string | undefined };

/** `POST …/export.csv`: the export's query as JSON — the filter as the grammar, not encoded. */
export type ExportBody = {
    filter?: FilterGroup | undefined;
    sort?: string | undefined;
    view?: string | undefined;
    q?: string | undefined;
    columns?: string | undefined;
};

/**
 * One function per API route, named for what it does, typed by `types.ts`. Paths are built here
 * and nowhere else; a component never spells `/w/` itself.
 */

const workspacePath = (workspaceId: string, rest: string) => `/w/${workspaceId}${rest}`;

export const auth = {
    signup: (input: SignupInput) =>
        request<{ user: UserView; workspace: WorkspaceView }>('POST', '/auth/signup', { body: input }),
    login: (input: LoginInput) => request<{ user: UserView }>('POST', '/auth/login', { body: input }),
    logout: () => request<void>('POST', '/auth/logout'),
    /** The providers, and who may sign up (P0-14): the sign-in and sign-up pages read both. */
    providers: () => request<AuthProvidersView>('GET', '/auth/providers'),
    /** What a workspace invitation is for; anyone holding the token may ask. */
    previewInvite: (token: string, signal?: AbortSignal) =>
        request<InvitePreviewView>('GET', `/auth/invites/${encodeURIComponent(token)}`, { signal }),
    /** Where the browser is sent to start a provider sign-in; a full-page navigation, not a fetch. */
    providerStartUrl: (issuer: string) => `/api/auth/oidc/${encodeURIComponent(issuer)}`,
    acceptInvite: (token: string) =>
        request<WorkspaceView>('POST', `/auth/invites/${encodeURIComponent(token)}/accept`),
    acceptInviteSignup: (token: string, password: string) =>
        request<WorkspaceView>('POST', `/auth/invites/${encodeURIComponent(token)}/signup`, { body: { password } }),
};

export const me = {
    current: (signal?: AbortSignal) => request<UserView>('GET', '/me', { signal }),
    /** The person's own profile: the name every workspace shows them under (P1-UI-10). */
    profile: (signal?: AbortSignal) => request<ProfileView>('GET', '/me/profile', { signal }),
    updateProfile: (displayName: string) => request<ProfileView>('PATCH', '/me/profile', { body: { displayName } }),
    workspaces: (signal?: AbortSignal) => request<WorkspaceView[]>('GET', '/me/workspaces', { signal }),
    createWorkspace: (name: string) => request<WorkspaceView>('POST', '/workspaces', { body: { name } }),
};

/** The operator's routes (P0-14): platform admins only, except `access`. */
export const platform = {
    access: (signal?: AbortSignal) => request<PlatformAccessView>('GET', '/platform/access', { signal }),
    workspaces: (signal?: AbortSignal) => request<PlatformWorkspaceView[]>('GET', '/platform/workspaces', { signal }),
    createWorkspace: (input: CreatePlatformWorkspaceInput) =>
        request<CreatedPlatformWorkspaceView>('POST', '/platform/workspaces', { body: input }),
    createSignupInvite: (input: CreateSignupInviteInput) =>
        request<PlatformInviteView>('POST', '/platform/signup-invites', { body: input }),
};

export const membership = {
    /** The caller's own standing in the workspace: what every permission-aware control reads. */
    me: (workspaceId: string, signal?: AbortSignal) =>
        request<MembershipSummary>('GET', workspacePath(workspaceId, '/me'), { signal }),
};

export const members = {
    list: (workspaceId: string, signal?: AbortSignal) =>
        request<MemberView[]>('GET', workspacePath(workspaceId, '/members'), { signal }),
    setRole: (workspaceId: string, memberId: string, roleId: string) =>
        request<void>('PATCH', workspacePath(workspaceId, `/members/${memberId}/role`), { body: { roleId } }),
    remove: (workspaceId: string, memberId: string) =>
        request<void>('DELETE', workspacePath(workspaceId, `/members/${memberId}`)),
};

export const roles = {
    list: (workspaceId: string, signal?: AbortSignal) =>
        request<RoleView[]>('GET', workspacePath(workspaceId, '/roles'), { signal }),
    create: (workspaceId: string, input: CreateRoleInput) =>
        request<RoleView>('POST', workspacePath(workspaceId, '/roles'), { body: input }),
    update: (workspaceId: string, roleId: string, input: UpdateRoleInput) =>
        request<RoleView>('PATCH', workspacePath(workspaceId, `/roles/${roleId}`), { body: input }),
    remove: (workspaceId: string, roleId: string) =>
        request<void>('DELETE', workspacePath(workspaceId, `/roles/${roleId}`)),
};

export const apiKeys = {
    list: (workspaceId: string, signal?: AbortSignal) =>
        request<ApiKeyView[]>('GET', workspacePath(workspaceId, '/api-keys'), { signal }),
    /** The secret in the response is shown once; the API does not keep it. */
    create: (workspaceId: string, input: CreateApiKeyInput) =>
        request<{ key: ApiKeyView; secret: string }>('POST', workspacePath(workspaceId, '/api-keys'), {
            body: input,
        }),
    revoke: (workspaceId: string, apiKeyId: string) =>
        request<void>('DELETE', workspacePath(workspaceId, `/api-keys/${apiKeyId}`)),
};

export const invites = {
    list: (workspaceId: string, signal?: AbortSignal) =>
        request<InviteView[]>('GET', workspacePath(workspaceId, '/invites'), { signal }),
    /** The token in the response is shown once so the admin can hand it on; the API keeps a hash. */
    create: (workspaceId: string, input: CreateInviteInput) =>
        request<{ invite: InviteView; token: string }>('POST', workspacePath(workspaceId, '/invites'), {
            body: input,
        }),
    revoke: (workspaceId: string, inviteId: string) =>
        request<void>('DELETE', workspacePath(workspaceId, `/invites/${inviteId}`)),
};

export const membersSummary = {
    /** Enough to name a member in a picker; readable by anyone with `record:read`. */
    list: (workspaceId: string, signal?: AbortSignal) =>
        request<MemberSummaryView[]>('GET', workspacePath(workspaceId, '/members/summary'), { signal }),
};

/** The three record objects share one shape of route: list, get, create, patch, delete, restore. */
function recordRoutes<View, Page, Input>(segment: string) {
    return {
        list: (workspaceId: string, params: ListParams = {}, signal?: AbortSignal) =>
            request<Page>('GET', workspacePath(workspaceId, `/${segment}${query(params)}`), { signal }),
        get: (workspaceId: string, id: string, signal?: AbortSignal) =>
            request<View>('GET', workspacePath(workspaceId, `/${segment}/${id}`), { signal }),
        create: (workspaceId: string, input: Input) =>
            request<View>('POST', workspacePath(workspaceId, `/${segment}`), { body: input }),
        update: (workspaceId: string, id: string, input: Input) =>
            request<View>('PATCH', workspacePath(workspaceId, `/${segment}/${id}`), { body: input }),
        remove: (workspaceId: string, id: string) =>
            request<void>('DELETE', workspacePath(workspaceId, `/${segment}/${id}`)),
        restore: (workspaceId: string, id: string) =>
            request<View>('POST', workspacePath(workspaceId, `/${segment}/${id}/restore`)),
        /** The current list as CSV: the API counts first and refuses (413) past its row cap. */
        exportCsv: (workspaceId: string, params: ExportParams, signal?: AbortSignal) =>
            requestFile(workspacePath(workspaceId, `/${segment}/export.csv${query(params)}`), { signal }),
        /**
         * The same export with the filter in a body (P1-4a): a selection's 500 ids do not fit in a
         * URL, so "export selected" sends `{ filter: id in [...] }` here.
         */
        exportSelection: (workspaceId: string, body: ExportBody) =>
            requestFile(workspacePath(workspaceId, `/${segment}/export.csv`), { method: 'POST', body }),
        /** One action over many records (P1-4a): one request, one result per record in the order named. */
        bulk: (workspaceId: string, input: BulkInput) =>
            request<BulkResultView>('POST', workspacePath(workspaceId, `/${segment}/bulk`), { body: input }),
    };
}

export const people = recordRoutes<PersonView, PersonPage, PersonInput>('people');
export const companies = recordRoutes<CompanyView, CompanyPage, CompanyInput>('companies');
export const opportunities = {
    ...recordRoutes<OpportunityView, OpportunityPage, OpportunityInput>('opportunities'),
    /** Create names where the deal starts; omitted, the default pipeline's first stage. */
    create: (workspaceId: string, input: OpportunityCreateInput) =>
        request<OpportunityView>('POST', workspacePath(workspaceId, '/opportunities'), { body: input }),
    /** A stage move (P1-2): into a won/lost stage the close payload is required; a backward move answers with the rules that may undo it. */
    move: (workspaceId: string, id: string, input: MoveDealInput) =>
        request<MoveResult>('POST', workspacePath(workspaceId, `/opportunities/${id}/move`), { body: input }),
    history: (workspaceId: string, id: string, signal?: AbortSignal) =>
        request<StageHistoryEntry[]>('GET', workspacePath(workspaceId, `/opportunities/${id}/history`), { signal }),
};

export const pipelines = {
    list: (workspaceId: string, signal?: AbortSignal) =>
        request<PipelineView[]>('GET', workspacePath(workspaceId, '/pipelines'), { signal }),
    get: (workspaceId: string, pipelineId: string, signal?: AbortSignal) =>
        request<PipelineView>('GET', workspacePath(workspaceId, `/pipelines/${pipelineId}`), { signal }),
    /** Every stage with its deals, count and exact sums under the caller's scope and the query (P1-2, P1-4). */
    board: (workspaceId: string, pipelineId: string, params: BoardQuery, signal?: AbortSignal) =>
        request<BoardView>(
            'GET',
            workspacePath(
                workspaceId,
                `/pipelines/${pipelineId}/board${query({ view: params.view, filter: params.filter, sort: params.sort, q: params.q })}`,
            ),
            { signal },
        ),
    rules: (workspaceId: string, pipelineId: string, signal?: AbortSignal) =>
        request<RuleView[]>('GET', workspacePath(workspaceId, `/pipelines/${pipelineId}/rules`), { signal }),
    /** Without `stages`, a new pipeline starts with the default stages (the API's one list). */
    create: (workspaceId: string, input: CreatePipelineInput) =>
        request<PipelineView>('POST', workspacePath(workspaceId, '/pipelines'), { body: input }),
    update: (workspaceId: string, pipelineId: string, input: UpdatePipelineInput) =>
        request<PipelineView>('PATCH', workspacePath(workspaceId, `/pipelines/${pipelineId}`), { body: input }),
    /** Only an empty, non-default pipeline goes; otherwise a 409 that says why. */
    remove: (workspaceId: string, pipelineId: string) =>
        request<void>('DELETE', workspacePath(workspaceId, `/pipelines/${pipelineId}`)),
    addStage: (workspaceId: string, pipelineId: string, input: CreateStageInput) =>
        request<PipelineView>('POST', workspacePath(workspaceId, `/pipelines/${pipelineId}/stages`), { body: input }),
    updateStage: (workspaceId: string, pipelineId: string, stageId: string, input: UpdateStageInput) =>
        request<PipelineView>('PATCH', workspacePath(workspaceId, `/pipelines/${pipelineId}/stages/${stageId}`), {
            body: input,
        }),
    /** Refused (409) while deals — the trash included — or rules point at the stage. */
    /**
     * Deletes a stage. With `moveDealsTo` (an open stage of the same pipeline) the server first moves
     * every deal in it — the trash included — in the same transaction (P1-2b); without it, a stage
     * holding deals is refused with `details: { liveDeals, trashedDeals }`.
     */
    removeStage: (workspaceId: string, pipelineId: string, stageId: string, moveDealsTo?: string) =>
        request<void>(
            'DELETE',
            workspacePath(workspaceId, `/pipelines/${pipelineId}/stages/${stageId}${query({ moveDealsTo })}`),
        ),
    /** `stageIds` is every stage of the pipeline, in the new order. */
    orderStages: (workspaceId: string, pipelineId: string, stageIds: readonly string[]) =>
        request<PipelineView>('PUT', workspacePath(workspaceId, `/pipelines/${pipelineId}/stages/order`), {
            body: { stageIds },
        }),
    createRule: (workspaceId: string, pipelineId: string, input: CreateRuleInput) =>
        request<RuleView>('POST', workspacePath(workspaceId, `/pipelines/${pipelineId}/rules`), { body: input }),
    updateRule: (workspaceId: string, pipelineId: string, ruleId: string, input: UpdateRuleInput) =>
        request<RuleView>('PATCH', workspacePath(workspaceId, `/pipelines/${pipelineId}/rules/${ruleId}`), {
            body: input,
        }),
    removeRule: (workspaceId: string, pipelineId: string, ruleId: string) =>
        request<void>('DELETE', workspacePath(workspaceId, `/pipelines/${pipelineId}/rules/${ruleId}`)),
};

export const views = {
    /** Shared views and the caller's own, for one object (P1-4). */
    list: (workspaceId: string, object: RecordObject, signal?: AbortSignal) =>
        request<SavedView[]>('GET', workspacePath(workspaceId, `/views${query({ object })}`), { signal }),
    create: (workspaceId: string, input: CreateViewInput) =>
        request<SavedView>('POST', workspacePath(workspaceId, '/views'), { body: input }),
    update: (workspaceId: string, viewId: string, input: UpdateViewInput) =>
        request<SavedView>('PATCH', workspacePath(workspaceId, `/views/${viewId}`), { body: input }),
    remove: (workspaceId: string, viewId: string) =>
        request<void>('DELETE', workspacePath(workspaceId, `/views/${viewId}`)),
};

export const customFields = {
    list: (workspaceId: string, object: RecordObject, signal?: AbortSignal) =>
        request<CustomFieldView[]>('GET', workspacePath(workspaceId, `/custom-fields${query({ object })}`), {
            signal,
        }),
    /** The archived definitions of one object: their values stay on records, the field is read-only. */
    listArchived: (workspaceId: string, object: RecordObject, signal?: AbortSignal) =>
        request<CustomFieldView[]>(
            'GET',
            workspacePath(workspaceId, `/custom-fields${query({ object, archived: 'true' })}`),
            { signal },
        ),
    create: (workspaceId: string, input: CreateCustomFieldInput) =>
        request<CustomFieldView>('POST', workspacePath(workspaceId, '/custom-fields'), { body: input }),
    update: (workspaceId: string, fieldId: string, input: UpdateCustomFieldInput) =>
        request<CustomFieldView>('PATCH', workspacePath(workspaceId, `/custom-fields/${fieldId}`), { body: input }),
    /** Archives, never deletes: records keep the value. */
    archive: (workspaceId: string, fieldId: string) =>
        request<void>('DELETE', workspacePath(workspaceId, `/custom-fields/${fieldId}`)),
    /** Un-archives: the key is accepted on records again (its key stayed reserved while archived). */
    restore: (workspaceId: string, fieldId: string) =>
        request<CustomFieldView>('POST', workspacePath(workspaceId, `/custom-fields/${fieldId}/restore`)),
};

export const notes = {
    list: (workspaceId: string, target: RecordTarget, cursor?: string, signal?: AbortSignal) =>
        request<NotePage>(
            'GET',
            workspacePath(workspaceId, `/notes${query({ target: targetParam(target), cursor })}`),
            { signal },
        ),
    create: (workspaceId: string, input: NoteCreateInput) =>
        request<NoteView>('POST', workspacePath(workspaceId, '/notes'), { body: input }),
    update: (workspaceId: string, id: string, input: NoteInput) =>
        request<NoteView>('PATCH', workspacePath(workspaceId, `/notes/${id}`), { body: input }),
    remove: (workspaceId: string, id: string) => request<void>('DELETE', workspacePath(workspaceId, `/notes/${id}`)),
};

export const tasks = {
    list: (
        workspaceId: string,
        params: {
            target?: RecordTarget | undefined;
            assigneeId?: string | undefined;
            status?: TaskStatus | undefined;
            cursor?: string | undefined;
        },
        signal?: AbortSignal,
    ) =>
        request<TaskPage>(
            'GET',
            workspacePath(
                workspaceId,
                `/tasks${query({
                    target: params.target ? targetParam(params.target) : undefined,
                    assigneeId: params.assigneeId,
                    status: params.status,
                    cursor: params.cursor,
                })}`,
            ),
            { signal },
        ),
    create: (workspaceId: string, input: TaskCreateInput) =>
        request<TaskView>('POST', workspacePath(workspaceId, '/tasks'), { body: input }),
    update: (workspaceId: string, id: string, input: TaskInput) =>
        request<TaskView>('PATCH', workspacePath(workspaceId, `/tasks/${id}`), { body: input }),
    remove: (workspaceId: string, id: string) => request<void>('DELETE', workspacePath(workspaceId, `/tasks/${id}`)),
};

export const attachments = {
    list: (workspaceId: string, target: RecordTarget, signal?: AbortSignal) =>
        request<AttachmentView[]>(
            'GET',
            workspacePath(workspaceId, `/attachments${query({ target: targetParam(target) })}`),
            { signal },
        ),
    /** The file is the multipart body (`file`); the target rides in the query string. */
    upload: (workspaceId: string, target: RecordTarget, file: File) => {
        const body = new FormData();
        body.set('file', file, file.name);
        return request<AttachmentView>(
            'POST',
            workspacePath(workspaceId, `/attachments${query({ target: targetParam(target) })}`),
            { body },
        );
    },
    /** A same-origin URL the browser fetches with the session cookie; never embedded, always opened. */
    contentUrl: (workspaceId: string, id: string) =>
        `${API_BASE}${workspacePath(workspaceId, `/attachments/${id}/content`)}`,
    remove: (workspaceId: string, id: string) =>
        request<void>('DELETE', workspacePath(workspaceId, `/attachments/${id}`)),
};

export const timeline = {
    list: (
        workspaceId: string,
        params: { target: RecordTarget; kinds?: string | undefined; cursor?: string | undefined },
        signal?: AbortSignal,
    ) =>
        request<TimelinePage>(
            'GET',
            workspacePath(
                workspaceId,
                `/timeline${query({ target: targetParam(params.target), kinds: params.kinds, cursor: params.cursor })}`,
            ),
            { signal },
        ),
};

export const search = {
    /** Ranked hits per object under the caller's scope; `objects` narrows to some of the three. */
    run: (
        workspaceId: string,
        params: { q: string; limit?: number | undefined; objects?: readonly RecordObject[] | undefined },
        signal?: AbortSignal,
    ) =>
        request<SearchResults>(
            'GET',
            workspacePath(
                workspaceId,
                `/search${query({ q: params.q, limit: params.limit, objects: params.objects?.join(',') })}`,
            ),
            { signal },
        ),
};

export const templates = {
    list: (workspaceId: string, params: TemplateListQuery, signal?: AbortSignal) =>
        request<EmailTemplatePage>(
            'GET',
            workspacePath(
                workspaceId,
                `/templates${query({ kind: params.kind, q: params.q, cursor: params.cursor, limit: params.limit })}`,
            ),
            { signal },
        ),
    get: (workspaceId: string, templateId: string, signal?: AbortSignal) =>
        request<EmailTemplateView>('GET', workspacePath(workspaceId, `/templates/${templateId}`), { signal }),
    /** The registry and the workspace's custom fields: what the editor's variable picker offers. */
    variables: (workspaceId: string, signal?: AbortSignal) =>
        request<TemplateVariablesView>('GET', workspacePath(workspaceId, '/templates/variables'), { signal }),
    create: (workspaceId: string, input: CreateTemplateInput) =>
        request<EmailTemplateView>('POST', workspacePath(workspaceId, '/templates'), { body: input }),
    update: (workspaceId: string, templateId: string, input: UpdateTemplateInput) =>
        request<EmailTemplateView>('PATCH', workspacePath(workspaceId, `/templates/${templateId}`), { body: input }),
    remove: (workspaceId: string, templateId: string) =>
        request<void>('DELETE', workspacePath(workspaceId, `/templates/${templateId}`)),
    duplicate: (workspaceId: string, templateId: string) =>
        request<EmailTemplateView>('POST', workspacePath(workspaceId, `/templates/${templateId}/duplicate`)),
    /** Renders against a real record; never sendable while a variable has no value. */
    preview: (workspaceId: string, templateId: string, input: PreviewTemplateInput) =>
        request<RenderedEmailView>('POST', workspacePath(workspaceId, `/templates/${templateId}/preview`), {
            body: input,
        }),
};

export const mailSettings = {
    get: (workspaceId: string, signal?: AbortSignal) =>
        request<MailSettingsView>('GET', workspacePath(workspaceId, '/settings/mail'), { signal }),
    put: (workspaceId: string, input: PutMailSettingsInput) =>
        request<MailSettingsView>('PUT', workspacePath(workspaceId, '/settings/mail'), { body: input }),
};

/**
 * The workspace's own Google OAuth client (P2-1, D-237). `describe`/`put`/`remove`/`verify` are an
 * admin's; `status` is every member's — whether Google is set up, without the client's details.
 */
export const oauthClient = {
    describe: (workspaceId: string, signal?: AbortSignal) =>
        request<GoogleOAuthClientView>('GET', workspacePath(workspaceId, '/mail/oauth-client'), { signal }),
    status: (workspaceId: string, signal?: AbortSignal) =>
        request<GoogleOAuthClientStatusView>('GET', workspacePath(workspaceId, '/mail/oauth-client/status'), {
            signal,
        }),
    put: (workspaceId: string, input: PutOAuthClientInput) =>
        request<GoogleOAuthClientView>('PUT', workspacePath(workspaceId, '/mail/oauth-client'), { body: input }),
    remove: (workspaceId: string) => request<void>('DELETE', workspacePath(workspaceId, '/mail/oauth-client')),
    verify: (workspaceId: string) =>
        request<GoogleOAuthClientView>('POST', workspacePath(workspaceId, '/mail/oauth-client/verify')),
};

/** Connected Google mailboxes (P2-1) and their sync (P2-2). */
export const mailboxes = {
    list: (workspaceId: string, signal?: AbortSignal) =>
        request<MailboxView[]>('GET', workspacePath(workspaceId, '/mailboxes'), { signal }),
    /** Starts a connect: the answer's `authorizeUrl` is where the browser goes next. */
    connect: (workspaceId: string, input: ConnectMailboxInput) =>
        request<MailboxConnectStartView>('POST', workspacePath(workspaceId, '/mailboxes/connect'), { body: input }),
    check: (workspaceId: string, mailboxId: string) =>
        request<MailboxCheckView>('POST', workspacePath(workspaceId, `/mailboxes/${mailboxId}/check`)),
    disconnect: (workspaceId: string, mailboxId: string) =>
        request<MailboxDisconnectedView>('DELETE', workspacePath(workspaceId, `/mailboxes/${mailboxId}`)),
    syncState: (workspaceId: string, mailboxId: string, signal?: AbortSignal) =>
        request<MailboxSyncView>('GET', workspacePath(workspaceId, `/mailboxes/${mailboxId}/sync`), { signal }),
    sync: (workspaceId: string, mailboxId: string) =>
        request<MailboxSyncTriggeredView>('POST', workspacePath(workspaceId, `/mailboxes/${mailboxId}/sync`)),
};

/** Addresses and domains whose mail is never imported, and removed when added (P2-2). */
export const blocklist = {
    list: (workspaceId: string, signal?: AbortSignal) =>
        request<BlocklistEntryView[]>('GET', workspacePath(workspaceId, '/mail/blocklist'), { signal }),
    create: (workspaceId: string, input: CreateBlocklistEntryInput) =>
        request<BlocklistEntryCreatedView>('POST', workspacePath(workspaceId, '/mail/blocklist'), { body: input }),
    remove: (workspaceId: string, entryId: string) =>
        request<void>('DELETE', workspacePath(workspaceId, `/mail/blocklist/${entryId}`)),
};

/**
 * Mail from a record (P2-3, P2-5): a send is accepted (`202`) and happens in a job, so its progress
 * is read back at `messages/:id`; a scheduled one can be moved or called off until it goes. Threads
 * are what sync stored (P2-2): bodies only for the owner of a personal mailbox, metadata otherwise.
 */
export const mail = {
    send: (workspaceId: string, input: SendMailInput) =>
        request<MailSendAcceptedView>('POST', workspacePath(workspaceId, '/mail/send'), { body: input }),
    message: (workspaceId: string, messageId: string, signal?: AbortSignal) =>
        request<MailOutboundView>('GET', workspacePath(workspaceId, `/mail/messages/${messageId}`), { signal }),
    reschedule: (workspaceId: string, messageId: string, input: RescheduleMailInput) =>
        request<MailOutboundView>('PATCH', workspacePath(workspaceId, `/mail/messages/${messageId}`), { body: input }),
    cancel: (workspaceId: string, messageId: string) =>
        request<MailOutboundView>('POST', workspacePath(workspaceId, `/mail/messages/${messageId}/cancel`)),
    /** The caller's scheduled sends (an admin's: everyone's), soonest first, a page at a time. */
    scheduled: (workspaceId: string, params: { limit: number; cursor?: string | undefined }, signal?: AbortSignal) =>
        request<MailScheduledPage>(
            'GET',
            workspacePath(workspaceId, `/mail/scheduled${query({ limit: params.limit, cursor: params.cursor })}`),
            { signal },
        ),
    thread: (workspaceId: string, threadId: string, signal?: AbortSignal) =>
        request<MailThreadView>('GET', workspacePath(workspaceId, `/mail/threads/${threadId}`), { signal }),
};

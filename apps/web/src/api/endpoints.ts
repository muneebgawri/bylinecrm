import type { FilterGroup, RecordObject, RecordTarget, TaskStatus } from '@bylinecrm/shared';
import { API_BASE, request, requestFile } from './client';
import type {
    ApiKeyView,
    AttachmentView,
    BoardQuery,
    BoardView,
    BulkInput,
    BulkResultView,
    CompanyInput,
    CompanyPage,
    CompanyView,
    CreateApiKeyInput,
    CreateInviteInput,
    CreateRoleInput,
    CreateViewInput,
    CustomFieldView,
    InviteView,
    LoginInput,
    MembershipSummary,
    MemberSummaryView,
    MemberView,
    MoveDealInput,
    MoveResult,
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
    RoleView,
    RuleView,
    SavedView,
    SearchResults,
    SignupInput,
    StageHistoryEntry,
    TaskInput,
    TaskPage,
    TaskView,
    TimelinePage,
    UpdateRoleInput,
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
    providers: () => request<{ providers: string[] }>('GET', '/auth/providers'),
    /** Where the browser is sent to start a provider sign-in; a full-page navigation, not a fetch. */
    providerStartUrl: (issuer: string) => `/api/auth/oidc/${encodeURIComponent(issuer)}`,
    acceptInvite: (token: string) =>
        request<WorkspaceView>('POST', `/auth/invites/${encodeURIComponent(token)}/accept`),
    acceptInviteSignup: (token: string, password: string) =>
        request<WorkspaceView>('POST', `/auth/invites/${encodeURIComponent(token)}/signup`, { body: { password } }),
};

export const me = {
    profile: (signal?: AbortSignal) => request<UserView>('GET', '/me', { signal }),
    workspaces: (signal?: AbortSignal) => request<WorkspaceView[]>('GET', '/me/workspaces', { signal }),
    createWorkspace: (name: string) => request<WorkspaceView>('POST', '/workspaces', { body: { name } }),
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
};

export const notes = {
    list: (workspaceId: string, target: RecordTarget, cursor?: string, signal?: AbortSignal) =>
        request<NotePage>(
            'GET',
            workspacePath(workspaceId, `/notes${query({ target: targetParam(target), cursor })}`),
            { signal },
        ),
    create: (workspaceId: string, input: NoteInput & { targets: RecordTarget[] }) =>
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
    create: (workspaceId: string, input: TaskInput & { title: string; targets: RecordTarget[] }) =>
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

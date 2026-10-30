import type { RecordObject, RecordTarget, TaskStatus } from '@bylinecrm/shared';
import { useMemo } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { API_BASE, request, requestFile } from './client';
import { query, targetParam, workspacePath, type ExportBody, type ExportParams, type ListParams } from './endpoints';
import { keys } from './queries';
import type {
    AddressCheckView,
    AttachmentView,
    BulkInput,
    BulkResultView,
    CompanyInput,
    CompanyPage,
    CompanyView,
    CreateCustomFieldInput,
    CreateViewInput,
    CustomFieldView,
    MemberSummaryView,
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
    SavedView,
    SearchResults,
    StageHistoryEntry,
    TaskCreateInput,
    TaskInput,
    TaskPage,
    TaskView,
    TimelinePage,
    UpdateCustomFieldInput,
    UpdateViewInput,
} from './types';

/**
 * Records and what hangs off them: people, companies and deals as records, saved views, custom fields, notes,
 * tasks, attachments, the timeline and search. They live apart from `queries.ts` so they load with the record
 * pages, not with every page (FR-CRMS-UI-10, #131).
 */

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

export const people = {
    ...recordRoutes<PersonView, PersonPage, PersonInput>('people'),
    /** Before a create: is this primary address free, and if not, whose person has it. */
    addressCheck: (workspaceId: string, email: string, signal?: AbortSignal) =>
        request<AddressCheckView>('GET', workspacePath(workspaceId, `/people/address-check${query({ email })}`), {
            signal,
        }),
};

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
    /** One record's entries with `target`; the workspace's feed without it. */
    list: (
        workspaceId: string,
        params: { target?: RecordTarget | undefined; kinds?: string | undefined; cursor?: string | undefined },
        signal?: AbortSignal,
    ) =>
        request<TimelinePage>(
            'GET',
            workspacePath(
                workspaceId,
                `/timeline${query({
                    target: params.target ? targetParam(params.target) : undefined,
                    kinds: params.kinds,
                    cursor: params.cursor,
                })}`,
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

// ─────────────────────────────────────────────────────────────────────────────
// Records, notes, tasks, attachments, timeline (P1-UI-3).
// ─────────────────────────────────────────────────────────────────────────────

/** The three record objects' routes, picked by object so one hook serves every record page. */
export const recordEndpoints = { person: people, company: companies, opportunity: opportunities } as const;

export type RecordViewOf<O extends RecordObject> = O extends 'person'
    ? PersonView
    : O extends 'company'
      ? CompanyView
      : OpportunityView;

/**
 * A page of one object's records. The three generated page schemas differ only in `items`, so
 * the page is spelled once with `items` tied to `O` — a conditional over the three whole pages
 * would collapse to their union inside a generic hook and lose which object it holds.
 */
export type RecordPageOf<O extends RecordObject> = Omit<PersonPage, 'items'> & { items: RecordViewOf<O>[] };

type Assert<T extends true> = T;

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** Compile-time only: stops compiling if the API's page shapes ever differ beyond `items`. */
export type PageShapesAgree = Assert<
    Same<Omit<PersonPage, 'items'>, Omit<CompanyPage, 'items'>> &
        Same<Omit<PersonPage, 'items'>, Omit<OpportunityPage, 'items'>>
>;

export type RecordInputOf<O extends RecordObject> = O extends 'person'
    ? PersonInput
    : O extends 'company'
      ? CompanyInput
      : OpportunityInput;

export function useRecord<O extends RecordObject>(workspaceId: string, object: O, id: string) {
    return useQuery({
        queryKey: keys.record(workspaceId, object, id),
        queryFn: ({ signal }) => recordEndpoints[object].get(workspaceId, id, signal) as Promise<RecordViewOf<O>>,
    });
}

export function useRecordList<O extends RecordObject>(
    workspaceId: string,
    object: O,
    params: Omit<ListParams, 'cursor'> = {},
    enabled = true,
) {
    return useQuery({
        queryKey: [...keys.records(workspaceId, object), 'list', params] as const,
        queryFn: ({ signal }) => recordEndpoints[object].list(workspaceId, params, signal) as Promise<RecordPageOf<O>>,
        enabled,
    });
}

/**
 * An inline edit's mutation: the cache shows the new value at once, the request follows, and a
 * refusal puts the old value back and surfaces the API's field error (FR-CRMS-UI-2). The record
 * list queries are invalidated so a table shows the change on return.
 */
export function usePatchRecord<O extends RecordObject>(workspaceId: string, object: O, id: string) {
    const client = useQueryClient();
    const key = keys.record(workspaceId, object, id);
    return useMutation({
        mutationFn: (patch: RecordInputOf<O>) =>
            recordEndpoints[object].update(workspaceId, id, patch as never) as Promise<RecordViewOf<O>>,
        onMutate: async (patch) => {
            await client.cancelQueries({ queryKey: key });
            const previous = client.getQueryData<RecordViewOf<O>>(key);
            if (previous) client.setQueryData<RecordViewOf<O>>(key, { ...previous, ...patch });
            return { previous };
        },
        onError: (_error, _patch, context) => {
            if (context?.previous) client.setQueryData(key, context.previous);
        },
        onSuccess: (view) => client.setQueryData(key, view),
        onSettled: () => {
            void client.invalidateQueries({ queryKey: keys.records(workspaceId, object), exact: false });
            void client.invalidateQueries({ queryKey: key });
        },
    });
}

export const useMembersSummary = (workspaceId: string) =>
    useQuery({
        queryKey: keys.membersSummary(workspaceId),
        queryFn: ({ signal }) => membersSummary.list(workspaceId, signal),
        staleTime: 5 * 60_000,
    });

/** Member id → name for owners and authors; one query every page shares. */
export function useMembersById(workspaceId: string): ReadonlyMap<string, string> {
    const members = useMembersSummary(workspaceId);
    return useMemo(
        () => new Map((members.data ?? []).map((m) => [m.memberId, m.name ?? 'Unnamed member'])),
        [members.data],
    );
}

export const useCustomFields = (workspaceId: string, object: RecordObject) =>
    useQuery({
        queryKey: keys.customFields(workspaceId, object),
        queryFn: ({ signal }) => customFields.list(workspaceId, object, signal),
        staleTime: 5 * 60_000,
    });

export const useViews = (workspaceId: string, object: RecordObject) =>
    useQuery({
        queryKey: keys.views(workspaceId, object),
        queryFn: ({ signal }) => views.list(workspaceId, object, signal),
    });

export function useCreateView(workspaceId: string) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: (input: CreateViewInput) => views.create(workspaceId, input),
        onSuccess: (view) => client.invalidateQueries({ queryKey: keys.views(workspaceId, view.object) }),
    });
}

export function useUpdateView(workspaceId: string, object: RecordObject) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: (input: { viewId: string } & UpdateViewInput) => {
            const { viewId, ...rest } = input;
            return views.update(workspaceId, viewId, rest);
        },
        onSuccess: () => client.invalidateQueries({ queryKey: keys.views(workspaceId, object) }),
    });
}

export function useDeleteView(workspaceId: string, object: RecordObject) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: (viewId: string) => views.remove(workspaceId, viewId),
        onSuccess: () => client.invalidateQueries({ queryKey: keys.views(workspaceId, object) }),
    });
}

export const useNotes = (workspaceId: string, target: RecordTarget) =>
    useInfiniteQuery({
        queryKey: keys.notes(workspaceId, target),
        queryFn: ({ pageParam, signal }) => notes.list(workspaceId, target, pageParam, signal),
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (page) => page.nextCursor ?? undefined,
    });

export function useSaveNote(workspaceId: string, target: RecordTarget) {
    const client = useQueryClient();
    const invalidate = () => {
        void client.invalidateQueries({ queryKey: keys.notes(workspaceId, target) });
        void client.invalidateQueries({ queryKey: ['w', workspaceId, 'timeline', target.type, target.id] });
    };
    return useMutation({
        mutationFn: ({ id, ...note }: { id?: string | undefined } & Omit<NoteCreateInput, 'targets'>) =>
            id ? notes.update(workspaceId, id, note) : notes.create(workspaceId, { ...note, targets: [target] }),
        onSuccess: invalidate,
    });
}

export function useDeleteNote(workspaceId: string, target: RecordTarget) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: (id: string) => notes.remove(workspaceId, id),
        onSuccess: () => {
            void client.invalidateQueries({ queryKey: keys.notes(workspaceId, target) });
            void client.invalidateQueries({ queryKey: ['w', workspaceId, 'timeline', target.type, target.id] });
        },
    });
}

export const useTasks = (workspaceId: string, target: RecordTarget, status?: TaskStatus) =>
    useInfiniteQuery({
        queryKey: [...keys.tasks(workspaceId, target), status ?? 'any'] as const,
        queryFn: ({ pageParam, signal }) => tasks.list(workspaceId, { target, status, cursor: pageParam }, signal),
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (page) => page.nextCursor ?? undefined,
    });

export function useSaveTask(workspaceId: string, target: RecordTarget) {
    const client = useQueryClient();
    const invalidate = () => {
        void client.invalidateQueries({ queryKey: keys.tasks(workspaceId, target) });
        void client.invalidateQueries({ queryKey: ['w', workspaceId, 'timeline', target.type, target.id] });
    };
    return useMutation({
        mutationFn: ({ id, ...task }: { id?: string | undefined } & Omit<TaskCreateInput, 'targets'>) =>
            id ? tasks.update(workspaceId, id, task) : tasks.create(workspaceId, { ...task, targets: [target] }),
        onSuccess: invalidate,
    });
}

export function useDeleteTask(workspaceId: string, target: RecordTarget) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: (id: string) => tasks.remove(workspaceId, id),
        onSuccess: () => {
            void client.invalidateQueries({ queryKey: keys.tasks(workspaceId, target) });
            void client.invalidateQueries({ queryKey: ['w', workspaceId, 'timeline', target.type, target.id] });
        },
    });
}

export const useAttachments = (workspaceId: string, target: RecordTarget) =>
    useQuery({
        queryKey: keys.attachments(workspaceId, target),
        queryFn: ({ signal }) => attachments.list(workspaceId, target, signal),
    });

export function useUploadAttachment(workspaceId: string, target: RecordTarget) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: (file: File) => attachments.upload(workspaceId, target, file),
        onSuccess: () => {
            void client.invalidateQueries({ queryKey: keys.attachments(workspaceId, target) });
            void client.invalidateQueries({ queryKey: ['w', workspaceId, 'timeline', target.type, target.id] });
        },
    });
}

export function useDeleteAttachment(workspaceId: string, target: RecordTarget) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: (id: string) => attachments.remove(workspaceId, id),
        onSuccess: () => {
            void client.invalidateQueries({ queryKey: keys.attachments(workspaceId, target) });
            void client.invalidateQueries({ queryKey: ['w', workspaceId, 'timeline', target.type, target.id] });
        },
    });
}

/** The record's activity, newest first, a page at a time; `kinds` narrows by prefix. */
/** The workspace's activity feed: every record the caller may read, newest first, a page at a time. */
export const useActivityFeed = (workspaceId: string, kinds: string | undefined) =>
    useInfiniteQuery({
        queryKey: ['w', workspaceId, 'timeline', 'feed', kinds ?? ''] as const,
        queryFn: ({ pageParam, signal }) => timeline.list(workspaceId, { kinds, cursor: pageParam }, signal),
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (page) => page.nextCursor ?? undefined,
    });

export const useTimeline = (workspaceId: string, target: RecordTarget, kinds: string | undefined) =>
    useInfiniteQuery({
        queryKey: keys.timeline(workspaceId, target, kinds),
        queryFn: ({ pageParam, signal }) => timeline.list(workspaceId, { target, kinds, cursor: pageParam }, signal),
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (page) => page.nextCursor ?? undefined,
    });

/**
 * The members a picker offers (#147): those in the workspace. A member who left stays in the summary
 * so the rows they left behind keep their name, and is never offered as an owner or an assignee.
 */
export function currentMembers<M extends { leftAt: string | null }>(members: readonly M[] | undefined): M[] {
    return (members ?? []).filter((m) => m.leftAt === null);
}

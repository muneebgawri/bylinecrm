import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { request } from './client';
import { query, workspacePath } from './endpoints';
import { keys } from './queries';
import type {
    CreateTemplateInput,
    EmailTemplatePage,
    EmailTemplateView,
    PreviewTemplateInput,
    RenderedEmailView,
    TemplateListQuery,
    TemplateVariablesView,
    UpdateTemplateInput,
} from './types';

/**
 * Email templates: the list, one template, its variables and preview. They live apart from `queries.ts` so
 * they load with the templates chunk (FR-CRMS-UI-10, #131).
 */

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

// ─────────────────────────────────────────────────────────────────────────────
// Templates and workspace mail settings (P2-UI-2).
// ─────────────────────────────────────────────────────────────────────────────

/** How many templates a page of the list holds; a workspace has dozens, not thousands. */
export const TEMPLATE_PAGE_SIZE = 50;

export function useTemplates(workspaceId: string, params: TemplateListQuery) {
    return useInfiniteQuery({
        queryKey: keys.templateList(workspaceId, params),
        queryFn: ({ pageParam, signal }) =>
            templates.list(workspaceId, { ...params, cursor: pageParam, limit: TEMPLATE_PAGE_SIZE }, signal),
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (last) => last.nextCursor ?? undefined,
    });
}

export const useTemplate = (workspaceId: string, templateId: string) =>
    useQuery({
        queryKey: keys.template(workspaceId, templateId),
        queryFn: ({ signal }) => templates.get(workspaceId, templateId, signal),
    });

export const useTemplateVariables = (workspaceId: string) =>
    useQuery({
        queryKey: keys.templateVariables(workspaceId),
        queryFn: ({ signal }) => templates.variables(workspaceId, signal),
        staleTime: 5 * 60_000,
    });

export function useCreateTemplate(workspaceId: string) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: (input: CreateTemplateInput) => templates.create(workspaceId, input),
        onSuccess: (created) => {
            client.setQueryData(keys.template(workspaceId, created.id), created);
            return client.invalidateQueries({ queryKey: keys.templates(workspaceId), exact: false });
        },
    });
}

/** Saves with the version the editor loaded; the server answers `409 conflict` when it moved on. */
export function useUpdateTemplate(workspaceId: string, templateId: string) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: (input: UpdateTemplateInput) => templates.update(workspaceId, templateId, input),
        onSuccess: (saved) => {
            client.setQueryData(keys.template(workspaceId, templateId), saved);
            return client.invalidateQueries({
                queryKey: keys.templates(workspaceId),
                predicate: ({ queryKey }) => queryKey[3] === 'list',
            });
        },
    });
}

export function useDeleteTemplate(workspaceId: string) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: (templateId: string) => templates.remove(workspaceId, templateId),
        onSuccess: () => client.invalidateQueries({ queryKey: keys.templates(workspaceId) }),
    });
}

export function useDuplicateTemplate(workspaceId: string) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: (templateId: string) => templates.duplicate(workspaceId, templateId),
        onSuccess: (copy) => {
            client.setQueryData(keys.template(workspaceId, copy.id), copy);
            return client.invalidateQueries({ queryKey: keys.templates(workspaceId) });
        },
    });
}

/** A preview is a read with a body: a mutation, so it runs when asked and is never cached stale. */
export function usePreviewTemplate(workspaceId: string, templateId: string) {
    return useMutation({
        mutationFn: (input: PreviewTemplateInput) => templates.preview(workspaceId, templateId, input),
    });
}

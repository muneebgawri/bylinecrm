import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { request } from './client';
import { query, workspacePath } from './endpoints';
import { keys } from './queries';
import { opportunities } from './records';
import type {
    BoardQuery,
    BoardView,
    CreatePipelineInput,
    CreateRuleInput,
    CreateStageInput,
    MoveDealInput,
    OpportunityCreateInput,
    OpportunityView,
    PipelineView,
    RuleView,
    UpdatePipelineInput,
    UpdateRuleInput,
    UpdateStageInput,
} from './types';

/**
 * Pipelines on the board and the deal list: the board query, stage moves, history and rules. They live apart
 * from `queries.ts` so they load with the deals chunk (FR-CRMS-UI-10, #131).
 */

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

export const usePipeline = (workspaceId: string, pipelineId: string) =>
    useQuery({
        queryKey: [...keys.pipelines(workspaceId), pipelineId] as const,
        queryFn: ({ signal }) => pipelines.get(workspaceId, pipelineId, signal),
        staleTime: 5 * 60_000,
    });

export const useDealHistory = (workspaceId: string, id: string) =>
    useQuery({
        queryKey: [...keys.record(workspaceId, 'opportunity', id), 'history'] as const,
        queryFn: ({ signal }) => opportunities.history(workspaceId, id, signal),
    });

export interface MoveDealVariables extends MoveDealInput {
    dealId: string;
    pipelineId: string;
}

/**
 * The one stage move, used by the deal page, the board, the list and the bulk bar. Before the
 * server answers, the card is moved in every cached board of the pipeline (the optimistic paint,
 * FR-CRMS-UI-10); a refusal puts those boards back (the snap-back) and the caller shows the reason.
 * The answer replaces the cached deal; its history, its timeline, the deal lists and the boards
 * refetch. Board counts and sums are the API's: they are never adjusted here.
 */
export function useMoveDeal(workspaceId: string) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: (input: MoveDealVariables) => {
            const body: MoveDealInput = { stageId: input.stageId };
            if (input.close) body.close = input.close;
            return opportunities.move(workspaceId, input.dealId, body);
        },
        onMutate: async (input) => {
            const prefix = keys.boards(workspaceId, input.pipelineId);
            await client.cancelQueries({ queryKey: prefix });
            const previous = client.getQueriesData<BoardView>({ queryKey: prefix });
            client.setQueriesData<BoardView>({ queryKey: prefix }, (board) =>
                board ? moveInBoard(board, input.dealId, input.stageId) : board,
            );
            return { previous };
        },
        onError: (_error, _input, context) => {
            for (const [key, board] of context?.previous ?? []) client.setQueryData(key, board);
        },
        onSuccess: (result, input) => {
            const key = keys.record(workspaceId, 'opportunity', input.dealId);
            client.setQueryData(key, result.deal);
            void client.invalidateQueries({ queryKey: [...key, 'history'] });
            void client.invalidateQueries({ queryKey: ['w', workspaceId, 'timeline', 'opportunity', input.dealId] });
            void client.invalidateQueries({ queryKey: keys.records(workspaceId, 'opportunity'), exact: false });
        },
        onSettled: (_result, _error, input) =>
            client.invalidateQueries({ queryKey: keys.boards(workspaceId, input.pipelineId) }),
    });
}

/** The same board with one deal in another column; the API's counts and sums are left as they were. */
export function moveInBoard(board: BoardView, dealId: string, stageId: string): BoardView {
    let moving: OpportunityView | undefined;
    const stripped = board.columns.map((column) => {
        const deal = column.deals.find((d) => d.id === dealId);
        if (!deal) return column;
        moving = deal;
        return { ...column, deals: column.deals.filter((d) => d.id !== dealId) };
    });
    if (!moving) return board;
    const moved = { ...moving, stageId };
    return {
        ...board,
        columns: stripped.map((column) =>
            column.stage.id === stageId ? { ...column, deals: [moved, ...column.deals] } : column,
        ),
    };
}

export const usePipelines = (workspaceId: string) =>
    useQuery({
        queryKey: keys.pipelines(workspaceId),
        queryFn: ({ signal }) => pipelines.list(workspaceId, signal),
        staleTime: 5 * 60_000,
    });

export const useRules = (workspaceId: string, pipelineId: string | undefined) =>
    useQuery({
        queryKey: keys.rules(workspaceId, pipelineId ?? ''),
        queryFn: ({ signal }) => pipelines.rules(workspaceId, pipelineId ?? '', signal),
        enabled: pipelineId !== undefined,
    });

/**
 * The board. Another member's move arrives by refetch when the window regains focus — never by
 * polling (doc 50 §B "stale").
 */
export const useBoard = (workspaceId: string, pipelineId: string | undefined, params: BoardQuery) =>
    useQuery({
        queryKey: keys.board(workspaceId, pipelineId ?? '', params),
        queryFn: ({ signal }) => pipelines.board(workspaceId, pipelineId ?? '', params, signal),
        enabled: pipelineId !== undefined,
        refetchOnWindowFocus: true,
    });

export function useCreateDeal(workspaceId: string) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: (input: OpportunityCreateInput) => opportunities.create(workspaceId, input),
        onSuccess: (deal) => {
            void client.invalidateQueries({ queryKey: keys.boards(workspaceId, deal.pipelineId) });
            void client.invalidateQueries({ queryKey: keys.records(workspaceId, 'opportunity'), exact: false });
        },
    });
}

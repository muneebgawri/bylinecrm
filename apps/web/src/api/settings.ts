import type { RecordObject } from '@bylinecrm/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { customFields, pipelines } from './endpoints';
import { keys } from './queries';
import type {
    CreateCustomFieldInput,
    CreatePipelineInput,
    CreateRuleInput,
    CreateStageInput,
    PipelineView,
    UpdateCustomFieldInput,
    UpdatePipelineInput,
    UpdateRuleInput,
    UpdateStageInput,
} from './types';

/**
 * The settings screens' reads and writes (P1-UI-8): pipelines, stages, stage rules and custom-field
 * definitions. They live apart from `queries.ts` so they load with the settings chunk, not with
 * every page (FR-CRMS-UI-10). Every write invalidates by the resource's key prefix, so the board,
 * the deal list, the record pages and the filter builder read the change on their next render.
 */

/** Every key under a workspace's pipelines: the list, each pipeline, its rules and its boards. */
function usePipelinesInvalidation(workspaceId: string) {
    const client = useQueryClient();
    return () => client.invalidateQueries({ queryKey: keys.pipelines(workspaceId) });
}

/** A stage write answers with the whole pipeline: paint it at once, then let the prefix refetch. */
function usePipelineWrite<V>(workspaceId: string, write: (input: V) => Promise<PipelineView>) {
    const client = useQueryClient();
    const invalidate = usePipelinesInvalidation(workspaceId);
    return useMutation({
        mutationFn: write,
        onSuccess: (pipeline) => {
            client.setQueryData([...keys.pipelines(workspaceId), pipeline.id], pipeline);
            return invalidate();
        },
    });
}

export function useCreatePipeline(workspaceId: string) {
    return usePipelineWrite(workspaceId, (input: CreatePipelineInput) => pipelines.create(workspaceId, input));
}

export function useUpdatePipeline(workspaceId: string, pipelineId: string) {
    return usePipelineWrite(workspaceId, (input: UpdatePipelineInput) =>
        pipelines.update(workspaceId, pipelineId, input),
    );
}

export function useRemovePipeline(workspaceId: string) {
    const invalidate = usePipelinesInvalidation(workspaceId);
    return useMutation({
        mutationFn: (pipelineId: string) => pipelines.remove(workspaceId, pipelineId),
        onSuccess: invalidate,
    });
}

export function useAddStage(workspaceId: string, pipelineId: string) {
    return usePipelineWrite(workspaceId, (input: CreateStageInput) =>
        pipelines.addStage(workspaceId, pipelineId, input),
    );
}

export function useUpdateStage(workspaceId: string, pipelineId: string) {
    return usePipelineWrite(workspaceId, ({ stageId, ...input }: { stageId: string } & UpdateStageInput) =>
        pipelines.updateStage(workspaceId, pipelineId, stageId, input),
    );
}

/**
 * Deletes a stage, optionally moving its deals to `moveDealsTo` first (one request, one transaction
 * on the server). Moved deals change stage, so the deal lists refetch along with the pipelines
 * (whose prefix holds the boards).
 */
export function useRemoveStage(workspaceId: string, pipelineId: string) {
    const client = useQueryClient();
    const invalidate = usePipelinesInvalidation(workspaceId);
    return useMutation({
        mutationFn: ({ stageId, moveDealsTo }: { stageId: string; moveDealsTo?: string }) =>
            pipelines.removeStage(workspaceId, pipelineId, stageId, moveDealsTo),
        onSuccess: async (_result, { moveDealsTo }) => {
            await invalidate();
            if (moveDealsTo) await client.invalidateQueries({ queryKey: keys.records(workspaceId, 'opportunity') });
        },
    });
}

/**
 * A reorder paints the new order before the server answers (FR-CRMS-UI-10) and puts the old one
 * back if it refuses.
 */
export function useOrderStages(workspaceId: string, pipelineId: string) {
    const client = useQueryClient();
    const key = [...keys.pipelines(workspaceId), pipelineId] as const;
    return useMutation({
        mutationFn: (stageIds: readonly string[]) => pipelines.orderStages(workspaceId, pipelineId, stageIds),
        onMutate: async (stageIds) => {
            await client.cancelQueries({ queryKey: key });
            const previous = client.getQueryData<PipelineView>(key);
            if (previous) {
                const byId = new Map(previous.stages.map((s) => [s.id, s]));
                const stages = stageIds.flatMap((id, i) => {
                    const stage = byId.get(id);
                    return stage ? [{ ...stage, position: i + 1 }] : [];
                });
                client.setQueryData<PipelineView>(key, { ...previous, stages });
            }
            return { previous };
        },
        onError: (_error, _ids, context) => {
            if (context?.previous) client.setQueryData(key, context.previous);
        },
        onSettled: () => client.invalidateQueries({ queryKey: keys.pipelines(workspaceId) }),
    });
}

export function useCreateRule(workspaceId: string, pipelineId: string) {
    const invalidate = usePipelinesInvalidation(workspaceId);
    return useMutation({
        mutationFn: (input: CreateRuleInput) => pipelines.createRule(workspaceId, pipelineId, input),
        onSuccess: invalidate,
    });
}

export function useUpdateRule(workspaceId: string, pipelineId: string) {
    const invalidate = usePipelinesInvalidation(workspaceId);
    return useMutation({
        mutationFn: ({ ruleId, ...input }: { ruleId: string } & UpdateRuleInput) =>
            pipelines.updateRule(workspaceId, pipelineId, ruleId, input),
        onSuccess: invalidate,
    });
}

export function useRemoveRule(workspaceId: string, pipelineId: string) {
    const invalidate = usePipelinesInvalidation(workspaceId);
    return useMutation({
        mutationFn: (ruleId: string) => pipelines.removeRule(workspaceId, pipelineId, ruleId),
        onSuccess: invalidate,
    });
}

/** Every key under a workspace's custom-field definitions, active and archived, for every object. */
const customFieldsPrefix = (workspaceId: string) => ['w', workspaceId, 'custom-fields'] as const;

export const useArchivedCustomFields = (workspaceId: string, object: RecordObject) =>
    useQuery({
        queryKey: [...keys.customFields(workspaceId, object), 'archived'] as const,
        queryFn: ({ signal }) => customFields.listArchived(workspaceId, object, signal),
    });

function useCustomFieldsInvalidation(workspaceId: string) {
    const client = useQueryClient();
    return () => client.invalidateQueries({ queryKey: customFieldsPrefix(workspaceId) });
}

export function useCreateCustomField(workspaceId: string) {
    const invalidate = useCustomFieldsInvalidation(workspaceId);
    return useMutation({
        mutationFn: (input: CreateCustomFieldInput) => customFields.create(workspaceId, input),
        onSuccess: invalidate,
    });
}

export function useUpdateCustomField(workspaceId: string) {
    const invalidate = useCustomFieldsInvalidation(workspaceId);
    return useMutation({
        mutationFn: ({ fieldId, ...input }: { fieldId: string } & UpdateCustomFieldInput) =>
            customFields.update(workspaceId, fieldId, input),
        onSuccess: invalidate,
    });
}

export function useRestoreCustomField(workspaceId: string) {
    const invalidate = useCustomFieldsInvalidation(workspaceId);
    return useMutation({
        mutationFn: (fieldId: string) => customFields.restore(workspaceId, fieldId),
        onSuccess: invalidate,
    });
}

export function useArchiveCustomField(workspaceId: string) {
    const invalidate = useCustomFieldsInvalidation(workspaceId);
    return useMutation({
        mutationFn: (fieldId: string) => customFields.archive(workspaceId, fieldId),
        onSuccess: invalidate,
    });
}

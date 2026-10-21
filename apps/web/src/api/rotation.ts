import type { RotationMemberView, RotationPreviewView, RotationSettingsView } from '@bylinecrm/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { request } from './client';
import { workspacePath } from './endpoints';
import { keys } from './queries';
import type { PipelineView } from './types';

export type RotationSettingsInput = Omit<RotationSettingsView, 'enabledAt'>;
export interface RotationMemberPatch {
    included?: boolean | null;
    paused?: boolean;
    resumeAt?: string | null;
    weight?: number;
}

/**
 * CADENCE-1: the follow-up cadence of each stage, and the lead rotation — its settings, who is in it, and the dry
 * run of what the hourly job would do (`pipeline:cadence`).
 */
export const rotation = {
    settings: (workspaceId: string, signal?: AbortSignal) =>
        request<RotationSettingsView>('GET', workspacePath(workspaceId, '/rotation/settings'), { signal }),
    setSettings: (workspaceId: string, input: RotationSettingsInput) =>
        request<RotationSettingsView>('PUT', workspacePath(workspaceId, '/rotation/settings'), { body: input }),
    members: (workspaceId: string, signal?: AbortSignal) =>
        request<RotationMemberView[]>('GET', workspacePath(workspaceId, '/rotation/members'), { signal }),
    setMember: (workspaceId: string, memberId: string, patch: RotationMemberPatch) =>
        request<RotationMemberView>('PATCH', workspacePath(workspaceId, `/rotation/members/${memberId}`), {
            body: patch,
        }),
    preview: (workspaceId: string, signal?: AbortSignal) =>
        request<RotationPreviewView>('GET', workspacePath(workspaceId, '/rotation/preview'), { signal }),
    setCadence: (
        workspaceId: string,
        pipelineId: string,
        stages: readonly { stageId: string; cadenceDays: number | null }[],
    ) =>
        request<PipelineView>('PUT', workspacePath(workspaceId, `/pipelines/${pipelineId}/cadence`), {
            body: { stages },
        }),
};

const rotationKey = (workspaceId: string) => ['w', workspaceId, 'rotation'] as const;

export const useRotationSettings = (workspaceId: string) =>
    useQuery({
        queryKey: [...rotationKey(workspaceId), 'settings'],
        queryFn: ({ signal }) => rotation.settings(workspaceId, signal),
    });

export const useRotationMembers = (workspaceId: string) =>
    useQuery({
        queryKey: [...rotationKey(workspaceId), 'members'],
        queryFn: ({ signal }) => rotation.members(workspaceId, signal),
    });

export const useRotationPreview = (workspaceId: string, enabled: boolean) =>
    useQuery({
        queryKey: [...rotationKey(workspaceId), 'preview'],
        queryFn: ({ signal }) => rotation.preview(workspaceId, signal),
        enabled,
    });

export function useSetRotationSettings(workspaceId: string) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: (input: RotationSettingsInput) => rotation.setSettings(workspaceId, input),
        onSuccess: (view) => client.setQueryData([...rotationKey(workspaceId), 'settings'], view),
        onSettled: () => void client.invalidateQueries({ queryKey: rotationKey(workspaceId) }),
    });
}

export function useSetRotationMember(workspaceId: string) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: ({ memberId, patch }: { memberId: string; patch: RotationMemberPatch }) =>
            rotation.setMember(workspaceId, memberId, patch),
        onSettled: () => void client.invalidateQueries({ queryKey: rotationKey(workspaceId) }),
    });
}

export function useSetCadence(workspaceId: string, pipelineId: string) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: (stages: readonly { stageId: string; cadenceDays: number | null }[]) =>
            rotation.setCadence(workspaceId, pipelineId, stages),
        onSuccess: (pipeline) => client.setQueryData([...keys.pipelines(workspaceId), pipeline.id], pipeline),
        onSettled: () => {
            void client.invalidateQueries({ queryKey: keys.pipelines(workspaceId) });
            void client.invalidateQueries({ queryKey: rotationKey(workspaceId) });
        },
    });
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { request } from './client';
import { workspacePath } from './endpoints';
import { importRunPollMs } from './importTwenty';
import { keys } from './queries';
import type {
    BiginContactReusePage,
    BiginImportMissingPage,
    BiginImportOverviewView,
    BiginImportPreviewView,
    BiginImportRunView,
    BiginImportSettingsView,
    PutBiginImportSettingsInput,
    PutBiginImportSyncInput,
    StartBiginImportInput,
    TwentyImportSyncView,
} from './types';

/** The Bigin importer (BIGIN-1): the connection, a preview of Bigin's counts, the runs and the automatic sync. */
export const biginImport = {
    overview: (workspaceId: string, signal?: AbortSignal) =>
        request<BiginImportOverviewView>('GET', workspacePath(workspaceId, '/import/bigin'), { signal }),
    putSettings: (workspaceId: string, input: PutBiginImportSettingsInput) =>
        request<BiginImportSettingsView>('PUT', workspacePath(workspaceId, '/import/bigin/settings'), { body: input }),
    removeSettings: (workspaceId: string) =>
        request<void>('DELETE', workspacePath(workspaceId, '/import/bigin/settings')),
    preview: (workspaceId: string) =>
        request<BiginImportPreviewView>('POST', workspacePath(workspaceId, '/import/bigin/preview')),
    start: (workspaceId: string, input: StartBiginImportInput) =>
        request<BiginImportRunView>('POST', workspacePath(workspaceId, '/import/bigin/runs'), { body: input }),
    runs: (workspaceId: string, signal?: AbortSignal) =>
        request<BiginImportRunView[]>('GET', workspacePath(workspaceId, '/import/bigin/runs'), { signal }),
    run: (workspaceId: string, runId: string, signal?: AbortSignal) =>
        request<BiginImportRunView>('GET', workspacePath(workspaceId, `/import/bigin/runs/${runId}`), { signal }),
    cancel: (workspaceId: string, runId: string) =>
        request<BiginImportRunView>('POST', workspacePath(workspaceId, `/import/bigin/runs/${runId}/cancel`)),
    missing: (workspaceId: string, signal?: AbortSignal) =>
        request<BiginImportMissingPage>('GET', workspacePath(workspaceId, '/import/bigin/missing?limit=200'), {
            signal,
        }),
    reuses: (workspaceId: string, signal?: AbortSignal) =>
        request<BiginContactReusePage>('GET', workspacePath(workspaceId, '/import/bigin/reuses?limit=100'), {
            signal,
        }),
    putSync: (workspaceId: string, input: PutBiginImportSyncInput) =>
        request<TwentyImportSyncView>('PUT', workspacePath(workspaceId, '/import/bigin/sync'), { body: input }),
    cutover: (workspaceId: string) =>
        request<TwentyImportSyncView>('POST', workspacePath(workspaceId, '/import/bigin/sync/cutover')),
};

export const useBiginImport = (workspaceId: string) =>
    useQuery({
        queryKey: keys.biginImport(workspaceId),
        queryFn: ({ signal }) => biginImport.overview(workspaceId, signal),
    });

export const useBiginImportRuns = (workspaceId: string) =>
    useQuery({
        queryKey: keys.biginImportRuns(workspaceId),
        queryFn: ({ signal }) => biginImport.runs(workspaceId, signal),
    });

export const useBiginImportMissing = (workspaceId: string) =>
    useQuery({
        queryKey: keys.biginImportMissing(workspaceId),
        queryFn: ({ signal }) => biginImport.missing(workspaceId, signal),
    });

export const useBiginContactReuses = (workspaceId: string) =>
    useQuery({
        queryKey: keys.biginImportReuses(workspaceId),
        queryFn: ({ signal }) => biginImport.reuses(workspaceId, signal),
    });

/** One run, read until it is over; the overview's latest run seeds it. */
export const useBiginImportRun = (workspaceId: string, runId: string | null, seed?: BiginImportRunView | null) =>
    useQuery({
        queryKey: keys.biginImportRun(workspaceId, runId ?? ''),
        queryFn: ({ signal }) => biginImport.run(workspaceId, runId ?? '', signal),
        enabled: runId !== null,
        ...(seed && seed.id === runId ? { initialData: seed, initialDataUpdatedAt: 0 } : {}),
        refetchInterval: (query: { state: { data: BiginImportRunView | undefined; dataUpdateCount: number } }) =>
            importRunPollMs(query.state.data, query.state.dataUpdateCount),
        refetchIntervalInBackground: true,
    });

/** Every Bigin importer query of the workspace, refreshed after a write. */
function useRefresh(workspaceId: string) {
    const client = useQueryClient();
    return () => client.invalidateQueries({ queryKey: keys.biginImport(workspaceId) });
}

export function usePutBiginSettings(workspaceId: string) {
    const refresh = useRefresh(workspaceId);
    return useMutation({
        mutationFn: (input: PutBiginImportSettingsInput) => biginImport.putSettings(workspaceId, input),
        onSuccess: refresh,
    });
}

export function useRemoveBiginSettings(workspaceId: string) {
    const refresh = useRefresh(workspaceId);
    return useMutation({ mutationFn: () => biginImport.removeSettings(workspaceId), onSuccess: refresh });
}

export const useBiginPreview = (workspaceId: string) =>
    useMutation({ mutationFn: () => biginImport.preview(workspaceId) });

export function useStartBiginImport(workspaceId: string) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: (input: StartBiginImportInput) => biginImport.start(workspaceId, input),
        onSuccess: (run) => {
            client.setQueryData(keys.biginImportRun(workspaceId, run.id), run);
            client.setQueryData<BiginImportOverviewView>(keys.biginImport(workspaceId), (current) =>
                current ? { ...current, latestRun: run } : current,
            );
            return client.invalidateQueries({ queryKey: keys.biginImportRuns(workspaceId) });
        },
    });
}

export function useCancelBiginImport(workspaceId: string) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: (runId: string) => biginImport.cancel(workspaceId, runId),
        onSuccess: (run) => client.setQueryData(keys.biginImportRun(workspaceId, run.id), run),
    });
}

export function usePutBiginSync(workspaceId: string) {
    const refresh = useRefresh(workspaceId);
    return useMutation({
        mutationFn: (input: PutBiginImportSyncInput) => biginImport.putSync(workspaceId, input),
        onSuccess: refresh,
    });
}

export function useBiginCutover(workspaceId: string) {
    const refresh = useRefresh(workspaceId);
    return useMutation({ mutationFn: () => biginImport.cutover(workspaceId), onSuccess: refresh });
}

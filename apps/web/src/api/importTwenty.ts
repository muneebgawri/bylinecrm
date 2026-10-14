import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { request } from './client';
import { workspacePath } from './endpoints';
import { keys } from './queries';
import type {
    PutTwentyImportSettingsInput,
    PutTwentyImportSyncInput,
    StartTwentyImportInput,
    TwentyImportMissingPage,
    TwentyImportOverviewView,
    TwentyImportPreviewView,
    TwentyImportRunView,
    TwentyImportSettingsView,
    TwentyImportSyncView,
} from './types';

/**
 * The Twenty importer (P4-4, P4-UI-2): the connection, a preview of Twenty's counts, and the runs.
 * Apart from `queries.ts` so it loads with the settings chunk (FR-CRMS-UI-10).
 */
export const twentyImport = {
    overview: (workspaceId: string, signal?: AbortSignal) =>
        request<TwentyImportOverviewView>('GET', workspacePath(workspaceId, '/import/twenty'), { signal }),
    putSettings: (workspaceId: string, input: PutTwentyImportSettingsInput) =>
        request<TwentyImportSettingsView>('PUT', workspacePath(workspaceId, '/import/twenty/settings'), {
            body: input,
        }),
    removeSettings: (workspaceId: string) =>
        request<void>('DELETE', workspacePath(workspaceId, '/import/twenty/settings')),
    preview: (workspaceId: string) =>
        request<TwentyImportPreviewView>('POST', workspacePath(workspaceId, '/import/twenty/preview')),
    start: (workspaceId: string, input: StartTwentyImportInput) =>
        request<TwentyImportRunView>('POST', workspacePath(workspaceId, '/import/twenty/runs'), { body: input }),
    runs: (workspaceId: string, signal?: AbortSignal) =>
        request<TwentyImportRunView[]>('GET', workspacePath(workspaceId, '/import/twenty/runs'), { signal }),
    run: (workspaceId: string, runId: string, signal?: AbortSignal) =>
        request<TwentyImportRunView>('GET', workspacePath(workspaceId, `/import/twenty/runs/${runId}`), { signal }),
    cancel: (workspaceId: string, runId: string) =>
        request<TwentyImportRunView>('POST', workspacePath(workspaceId, `/import/twenty/runs/${runId}/cancel`)),
    missing: (workspaceId: string, signal?: AbortSignal) =>
        request<TwentyImportMissingPage>('GET', workspacePath(workspaceId, '/import/twenty/missing?limit=200'), {
            signal,
        }),
    putSync: (workspaceId: string, input: PutTwentyImportSyncInput) =>
        request<TwentyImportSyncView>('PUT', workspacePath(workspaceId, '/import/twenty/sync'), { body: input }),
    cutover: (workspaceId: string) =>
        request<TwentyImportSyncView>('POST', workspacePath(workspaceId, '/import/twenty/sync/cutover')),
};

const POLL_FIRST_MS = 1_000;
const POLL_MAX_MS = 5_000;

/** A run still going is read again with backoff — 1s, 2s, 4s, then every 5s; one that finished never. */
export function importRunPollMs(view: Pick<TwentyImportRunView, 'status'> | undefined, reads: number): number | false {
    if (view && view.status !== 'queued' && view.status !== 'running') return false;
    return Math.min(POLL_FIRST_MS * 2 ** Math.max(reads - 1, 0), POLL_MAX_MS);
}

/** Whether a run is over, whichever way. */
export function isFinalRun(view: Pick<TwentyImportRunView, 'status'> | undefined): boolean {
    return view !== undefined && view.status !== 'queued' && view.status !== 'running';
}

export const useTwentyImport = (workspaceId: string, enabled = true) =>
    useQuery({
        queryKey: keys.twentyImport(workspaceId),
        queryFn: ({ signal }) => twentyImport.overview(workspaceId, signal),
        enabled,
    });

/** The records a reconcile pass flagged as missing in Twenty (#156): the first 200, for review. */
export const useTwentyImportMissing = (workspaceId: string, enabled = true) =>
    useQuery({
        queryKey: keys.twentyImportMissing(workspaceId),
        queryFn: ({ signal }) => twentyImport.missing(workspaceId, signal),
        enabled,
    });

export const useTwentyImportRuns = (workspaceId: string, enabled = true) =>
    useQuery({
        queryKey: keys.twentyImportRuns(workspaceId),
        queryFn: ({ signal }) => twentyImport.runs(workspaceId, signal),
        enabled,
    });

/** One run, read until it is over (`importRunPollMs`); the overview's latest run seeds it. */
export const useTwentyImportRun = (workspaceId: string, runId: string | null, seed?: TwentyImportRunView | null) =>
    useQuery({
        queryKey: keys.twentyImportRun(workspaceId, runId ?? ''),
        queryFn: ({ signal }) => twentyImport.run(workspaceId, runId ?? '', signal),
        enabled: runId !== null,
        ...(seed && seed.id === runId ? { initialData: seed, initialDataUpdatedAt: 0 } : {}),
        refetchInterval: (query: { state: { data: TwentyImportRunView | undefined; dataUpdateCount: number } }) =>
            importRunPollMs(query.state.data, query.state.dataUpdateCount),
        refetchIntervalInBackground: true,
    });

export function usePutTwentySettings(workspaceId: string) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: (input: PutTwentyImportSettingsInput) => twentyImport.putSettings(workspaceId, input),
        onSuccess: (settings) => {
            client.setQueryData<TwentyImportOverviewView>(keys.twentyImport(workspaceId), (current) =>
                current ? { ...current, settings } : current,
            );
            return client.invalidateQueries({ queryKey: keys.twentyImport(workspaceId) });
        },
    });
}

export function useRemoveTwentySettings(workspaceId: string) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: () => twentyImport.removeSettings(workspaceId),
        onSuccess: () => client.invalidateQueries({ queryKey: keys.twentyImport(workspaceId) }),
    });
}

export const useTwentyPreview = (workspaceId: string) =>
    useMutation({ mutationFn: () => twentyImport.preview(workspaceId) });

/** Starts a run; the answer is the queued run, put where the poll reads it, so the screen follows it at once. */
export function useStartTwentyImport(workspaceId: string) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: (input: StartTwentyImportInput) => twentyImport.start(workspaceId, input),
        onSuccess: (run) => {
            client.setQueryData(keys.twentyImportRun(workspaceId, run.id), run);
            client.setQueryData<TwentyImportOverviewView>(keys.twentyImport(workspaceId), (current) =>
                current ? { ...current, latestRun: run } : current,
            );
            return client.invalidateQueries({ queryKey: keys.twentyImportRuns(workspaceId) });
        },
    });
}

export function useCancelTwentyImport(workspaceId: string) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: (runId: string) => twentyImport.cancel(workspaceId, runId),
        onSuccess: (run) => client.setQueryData(keys.twentyImportRun(workspaceId, run.id), run),
    });
}

/** The automatic sync's interval (#185); the answer is the sync as it now is, put on the overview. */
export function usePutTwentySync(workspaceId: string) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: (input: PutTwentyImportSyncInput) => twentyImport.putSync(workspaceId, input),
        onSuccess: (sync) => {
            client.setQueryData<TwentyImportOverviewView>(keys.twentyImport(workspaceId), (current) =>
                current ? { ...current, sync } : current,
            );
        },
    });
}

/** Stop syncing (cutover, #185): off for good, with the moment recorded. */
export function useTwentyCutover(workspaceId: string) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: () => twentyImport.cutover(workspaceId),
        onSuccess: (sync) => {
            client.setQueryData<TwentyImportOverviewView>(keys.twentyImport(workspaceId), (current) =>
                current ? { ...current, sync } : current,
            );
        },
    });
}

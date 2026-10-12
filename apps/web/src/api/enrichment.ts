import type { EnrichmentObject } from '@bylinecrm/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { request } from './client';
import { workspacePath } from './endpoints';
import { keys } from './queries';
import type { EnrichmentHistoryView, EnrichmentSettingsView, PutEnrichmentSettingsInput } from './types';

/**
 * Enrichment (P4-2, FR-CRMS-15): a record's answers and _Enrich now_, and the workspace's sources
 * and re-ask age. Apart from `queries.ts` so it loads with the record and settings chunks.
 */
export const enrichment = {
    history: (workspaceId: string, object: EnrichmentObject, recordId: string, signal?: AbortSignal) =>
        request<EnrichmentHistoryView>('GET', workspacePath(workspaceId, `/enrichment/${object}/${recordId}`), {
            signal,
        }),
    enrichNow: (workspaceId: string, object: EnrichmentObject, recordId: string) =>
        request<EnrichmentHistoryView>('POST', workspacePath(workspaceId, `/enrichment/${object}/${recordId}`)),
    settings: (workspaceId: string, signal?: AbortSignal) =>
        request<EnrichmentSettingsView>('GET', workspacePath(workspaceId, '/enrichment/settings'), { signal }),
    putSettings: (workspaceId: string, input: PutEnrichmentSettingsInput) =>
        request<EnrichmentSettingsView>('PUT', workspacePath(workspaceId, '/enrichment/settings'), { body: input }),
};

/** While a run is queued or going the panel asks again every few seconds; a settled record is read once. */
export const ENRICHMENT_POLL_MS = 3000;

export const useEnrichment = (workspaceId: string, object: EnrichmentObject, recordId: string) =>
    useQuery({
        queryKey: keys.enrichment(workspaceId, object, recordId),
        queryFn: ({ signal }) => enrichment.history(workspaceId, object, recordId, signal),
        refetchInterval: (query) => (query.state.data?.pending ? ENRICHMENT_POLL_MS : false),
    });

export function useEnrichNow(workspaceId: string, object: EnrichmentObject, recordId: string) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: () => enrichment.enrichNow(workspaceId, object, recordId),
        onSuccess: (history) => client.setQueryData(keys.enrichment(workspaceId, object, recordId), history),
    });
}

export const useEnrichmentSettings = (workspaceId: string) =>
    useQuery({
        queryKey: keys.enrichmentSettings(workspaceId),
        queryFn: ({ signal }) => enrichment.settings(workspaceId, signal),
    });

export function usePutEnrichmentSettings(workspaceId: string) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: (input: PutEnrichmentSettingsInput) => enrichment.putSettings(workspaceId, input),
        onSuccess: () => client.invalidateQueries({ queryKey: keys.enrichmentSettings(workspaceId) }),
    });
}

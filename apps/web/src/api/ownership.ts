import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { request } from './client';
import { workspacePath } from './endpoints';
import type { CompanyDomainView, OwnershipConflictView } from './types';

/**
 * Company-domain ownership (OWN-2, #201): a company's other domains, and the records that disagree with
 * the rule (a manager's to resolve). Resolving moves records between members, so every record list, the
 * transfers and the bell are asked again.
 */

const keys = {
    conflicts: (workspaceId: string) => ['w', workspaceId, 'ownership', 'conflicts'] as const,
    domains: (workspaceId: string, companyId: string) => ['w', workspaceId, 'company', companyId, 'domains'] as const,
};

export const ownership = {
    conflicts: (workspaceId: string, signal?: AbortSignal) =>
        request<OwnershipConflictView[]>('GET', workspacePath(workspaceId, '/ownership/conflicts'), { signal }),
    resolve: (workspaceId: string, items: readonly { object: 'person' | 'opportunity'; recordId: string }[]) =>
        request<{ resolved: string[]; skipped: string[] }>(
            'POST',
            workspacePath(workspaceId, '/ownership/conflicts/resolve'),
            { body: { items } },
        ),
    domains: (workspaceId: string, companyId: string, signal?: AbortSignal) =>
        request<CompanyDomainView[]>('GET', workspacePath(workspaceId, `/companies/${companyId}/domains`), { signal }),
    addDomain: (workspaceId: string, companyId: string, domain: string) =>
        request<CompanyDomainView>('POST', workspacePath(workspaceId, `/companies/${companyId}/domains`), {
            body: { domain },
        }),
    removeDomain: (workspaceId: string, companyId: string, domain: string) =>
        request<void>(
            'DELETE',
            workspacePath(workspaceId, `/companies/${companyId}/domains/${encodeURIComponent(domain)}`),
        ),
};

export function useOwnershipConflicts(workspaceId: string, enabled = true) {
    return useQuery({
        queryKey: keys.conflicts(workspaceId),
        queryFn: ({ signal }) => ownership.conflicts(workspaceId, signal),
        enabled,
    });
}

export function useResolveConflicts(workspaceId: string) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: (items: readonly { object: 'person' | 'opportunity'; recordId: string }[]) =>
            ownership.resolve(workspaceId, items),
        onSuccess: () => {
            void client.invalidateQueries({ queryKey: keys.conflicts(workspaceId) });
            for (const object of ['person', 'company', 'opportunity', 'transfers', 'notifications']) {
                void client.invalidateQueries({ queryKey: ['w', workspaceId, object], exact: false });
            }
        },
    });
}

export function useCompanyDomains(workspaceId: string, companyId: string) {
    return useQuery({
        queryKey: keys.domains(workspaceId, companyId),
        queryFn: ({ signal }) => ownership.domains(workspaceId, companyId, signal),
    });
}

export function useAddCompanyDomain(workspaceId: string, companyId: string) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: (domain: string) => ownership.addDomain(workspaceId, companyId, domain),
        onSuccess: () => client.invalidateQueries({ queryKey: keys.domains(workspaceId, companyId) }),
    });
}

export function useRemoveCompanyDomain(workspaceId: string, companyId: string) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: (domain: string) => ownership.removeDomain(workspaceId, companyId, domain),
        onSuccess: () => client.invalidateQueries({ queryKey: keys.domains(workspaceId, companyId) }),
    });
}

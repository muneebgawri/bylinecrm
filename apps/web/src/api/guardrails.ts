import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { request } from './client';
import { query, workspacePath } from './endpoints';
import type {
    GuardrailEventPage,
    GuardrailEventView,
    GuardrailEventsQuery,
    GuardrailSettingsView,
    MailboxCoverageView,
} from './types';

/**
 * Guardrails (GUARD-1, #202): what the recipient guard refused, warned of or let a manager through, for
 * reviewers (`guardrail:review`), and marking one legitimate with a reason.
 */

const keys = {
    all: (workspaceId: string) => ['w', workspaceId, 'guardrails'] as const,
    events: (workspaceId: string, q: GuardrailEventsQuery) => ['w', workspaceId, 'guardrails', 'events', q] as const,
    coverage: (workspaceId: string) => ['w', workspaceId, 'guardrails', 'mailbox-coverage'] as const,
    settings: (workspaceId: string) => ['w', workspaceId, 'guardrails', 'settings'] as const,
};

export const guardrails = {
    events: (workspaceId: string, q: GuardrailEventsQuery, signal?: AbortSignal) =>
        request<GuardrailEventPage>(
            'GET',
            workspacePath(
                workspaceId,
                `/guardrails/events${query({
                    kind: q.kind,
                    outcome: q.outcome,
                    actorMemberId: q.actorMemberId,
                    reviewed: q.reviewed,
                    cursor: q.cursor,
                    limit: q.limit,
                })}`,
            ),
            { signal },
        ),
    mailboxCoverage: (workspaceId: string, signal?: AbortSignal) =>
        request<MailboxCoverageView[]>('GET', workspacePath(workspaceId, '/guardrails/mailbox-coverage'), { signal }),
    settings: (workspaceId: string, signal?: AbortSignal) =>
        request<GuardrailSettingsView>('GET', workspacePath(workspaceId, '/guardrails/settings'), { signal }),
    updateSettings: (workspaceId: string, input: GuardrailSettingsView) =>
        request<GuardrailSettingsView>('PUT', workspacePath(workspaceId, '/guardrails/settings'), { body: input }),
    markLegitimate: (workspaceId: string, id: string, reason: string) =>
        request<GuardrailEventView>('POST', workspacePath(workspaceId, `/guardrails/events/${id}/legitimate`), {
            body: { reason },
        }),
};

export function useGuardrailEvents(workspaceId: string, q: GuardrailEventsQuery) {
    return useQuery({
        queryKey: keys.events(workspaceId, q),
        queryFn: ({ signal }) => guardrails.events(workspaceId, q, signal),
    });
}

/** GUARD-2: every active member and whether sync sees their mail. */
export function useMailboxCoverage(workspaceId: string) {
    return useQuery({
        queryKey: keys.coverage(workspaceId),
        queryFn: ({ signal }) => guardrails.mailboxCoverage(workspaceId, signal),
    });
}

export function useMarkLegitimate(workspaceId: string) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: ({ id, reason }: { id: string; reason: string }) =>
            guardrails.markLegitimate(workspaceId, id, reason),
        onSuccess: () => client.invalidateQueries({ queryKey: keys.all(workspaceId) }),
    });
}

/** GUARD-2's settings: high poaching alerts emailed at once, and the shared mailboxes (read by reviewers, set by admins). */
export function useGuardrailSettings(workspaceId: string, enabled = true) {
    return useQuery({
        queryKey: keys.settings(workspaceId),
        queryFn: ({ signal }) => guardrails.settings(workspaceId, signal),
        enabled,
    });
}

export function useUpdateGuardrailSettings(workspaceId: string) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: (input: GuardrailSettingsView) => guardrails.updateSettings(workspaceId, input),
        onSuccess: (saved) => client.setQueryData(keys.settings(workspaceId), saved),
    });
}

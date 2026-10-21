import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { request } from './client';
import { query, workspacePath } from './endpoints';
import type { GuardrailEventPage, GuardrailEventView, GuardrailEventsQuery, MailboxCoverageView } from './types';

/**
 * Guardrails (GUARD-1, #202): what the recipient guard refused, warned of or let a manager through, for
 * reviewers (`guardrail:review`), and marking one legitimate with a reason.
 */

const keys = {
    all: (workspaceId: string) => ['w', workspaceId, 'guardrails'] as const,
    events: (workspaceId: string, q: GuardrailEventsQuery) => ['w', workspaceId, 'guardrails', 'events', q] as const,
    coverage: (workspaceId: string) => ['w', workspaceId, 'guardrails', 'mailbox-coverage'] as const,
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

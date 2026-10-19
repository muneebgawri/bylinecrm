import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { request } from './client';
import { workspacePath } from './endpoints';
import type { RecordObject } from '@bylinecrm/shared';
import type { TransferView } from './types';

/**
 * Ownership transfers (OWN-1, #200): a record's offers and history, and the four things a member does
 * with one — offer (or, with `record:transfer`, move at once), accept, decline, cancel. A completed
 * transfer moves a whole unit (a company with its people and open deals), so every record list and
 * record is asked again, not only the one on screen.
 */

const keys = {
    all: (workspaceId: string) => ['w', workspaceId, 'transfers'] as const,
    record: (workspaceId: string, object: RecordObject, recordId: string) =>
        ['w', workspaceId, 'transfers', object, recordId] as const,
};

export const transfers = {
    forRecord: (workspaceId: string, object: RecordObject, recordId: string, signal?: AbortSignal) =>
        request<TransferView[]>(
            'GET',
            workspacePath(workspaceId, `/transfers?object=${object}&recordId=${encodeURIComponent(recordId)}`),
            { signal },
        ),
    propose: (
        workspaceId: string,
        input: { object: RecordObject; recordId: string; toMemberId: string; reason?: string },
    ) => request<TransferView>('POST', workspacePath(workspaceId, '/transfers'), { body: input }),
    decide: (workspaceId: string, id: string, action: 'accept' | 'decline' | 'cancel', note?: string) =>
        request<TransferView>('POST', workspacePath(workspaceId, `/transfers/${id}/${action}`), {
            body: note ? { note } : {},
        }),
};

export function useRecordTransfers(workspaceId: string, object: RecordObject, recordId: string) {
    return useQuery({
        queryKey: keys.record(workspaceId, object, recordId),
        queryFn: ({ signal }) => transfers.forRecord(workspaceId, object, recordId, signal),
        enabled: recordId !== '',
    });
}

/** After any decision: the transfers, every record (a unit may have moved), and the bell. */
function useAfterTransfer(workspaceId: string) {
    const client = useQueryClient();
    return () => {
        void client.invalidateQueries({ queryKey: keys.all(workspaceId) });
        for (const object of ['person', 'company', 'opportunity'] as const) {
            void client.invalidateQueries({ queryKey: ['w', workspaceId, object], exact: false });
        }
        void client.invalidateQueries({ queryKey: ['w', workspaceId, 'timeline'], exact: false });
        void client.invalidateQueries({ queryKey: ['w', workspaceId, 'notifications'], exact: false });
    };
}

export function useProposeTransfer(workspaceId: string) {
    const after = useAfterTransfer(workspaceId);
    return useMutation({
        mutationFn: (input: { object: RecordObject; recordId: string; toMemberId: string; reason?: string }) =>
            transfers.propose(workspaceId, input),
        onSuccess: after,
    });
}

export function useDecideTransfer(workspaceId: string) {
    const after = useAfterTransfer(workspaceId);
    return useMutation({
        mutationFn: ({ id, action, note }: { id: string; action: 'accept' | 'decline' | 'cancel'; note?: string }) =>
            transfers.decide(workspaceId, id, action, note),
        onSuccess: after,
    });
}

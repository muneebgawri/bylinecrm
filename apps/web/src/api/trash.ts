import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { request } from './client';
import { workspacePath } from './endpoints';
import { keys } from './queries';
import { recordEndpoints } from './records';
import type { TrashedCompanyPage, TrashedPersonPage } from './types';

/**
 * The trash: the people and companies a member deleted, each with when, why and by whom, and putting one back.
 * A member sees what their role lets them see live — their own records, or everyone's.
 */

export type TrashObject = 'person' | 'company';
export type TrashedPageOf<O extends TrashObject> = O extends 'person' ? TrashedPersonPage : TrashedCompanyPage;
export type TrashedOf<O extends TrashObject> = TrashedPageOf<O>['items'][number];

const SEGMENT: Record<TrashObject, string> = { person: 'people', company: 'companies' };

/** Records a page of the trash asks for. */
export const TRASH_PAGE = 50;

export const trash = {
    list: <O extends TrashObject>(workspaceId: string, object: O, cursor?: string, signal?: AbortSignal) =>
        request<TrashedPageOf<O>>(
            'GET',
            workspacePath(
                workspaceId,
                `/${SEGMENT[object]}/deleted?limit=${TRASH_PAGE}&sort=updatedAt:desc${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
            ),
            { signal },
        ),
};

/** Under the object's record key, so a delete or a restore anywhere asks the trash again. */
const trashKey = (workspaceId: string, object: TrashObject) => [...keys.records(workspaceId, object), 'trash'] as const;

export function useTrash<O extends TrashObject>(workspaceId: string, object: O, enabled = true) {
    return useInfiniteQuery({
        queryKey: trashKey(workspaceId, object),
        queryFn: ({ pageParam, signal }) => trash.list(workspaceId, object, pageParam, signal),
        initialPageParam: undefined as string | undefined,
        getNextPageParam: (last) => last.nextCursor ?? undefined,
        enabled,
    });
}

/** Puts one record back; the object's lists and the trash are asked again. */
export function useRestoreRecord(workspaceId: string, object: TrashObject) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: async (id: string): Promise<void> => {
            await recordEndpoints[object].restore(workspaceId, id);
        },
        onSuccess: () => client.invalidateQueries({ queryKey: keys.records(workspaceId, object) }),
    });
}

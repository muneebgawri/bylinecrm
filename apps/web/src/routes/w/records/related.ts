import { LIST_LIMIT_MAX, type RecordObject } from '@bylinecrm/shared';
import { useRecordList } from '../../../api/records';
import { encodeFilter } from '../../../lib/filterParam';

/**
 * The records that point at this one (a company's people, a person's deals), asked of the API
 * with a filter — never a page of everything filtered here, which silently missed whatever sat
 * past the first page. `more` says the rail is showing the first page of a longer list.
 */
export function useRelated<O extends RecordObject>(workspaceId: string, object: O, field: string, id: string) {
    const list = useRecordList(workspaceId, object, {
        filter: encodeFilter({ and: [{ field, op: 'eq', value: id }] }),
        limit: LIST_LIMIT_MAX,
    });
    return { ...list, items: list.data?.items ?? [], more: Boolean(list.data?.nextCursor) };
}

/** "12", or "200+" when the API has more than the rail asked for. */
export function countLabel(count: number, more: boolean): string {
    return more ? `${count}+` : String(count);
}

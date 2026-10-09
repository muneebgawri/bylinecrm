import { useLocation } from 'react-router';

/**
 * Prev/next on a record page follow the list it was opened from. A list page navigates with
 * `state: { list: { ids } }`; a page opened from elsewhere (a link, the palette) has no list
 * and shows no arrows. Nothing is fetched to find neighbours — the list already knew them.
 */
export interface ListState {
    list?: { ids: string[] };
}

export function useSiblings(
    currentId: string,
    pathOf: (id: string) => string,
): { prev: string | null; next: string | null } | undefined {
    const state = useLocation().state as ListState | null;
    const ids = state?.list?.ids;
    if (!ids) return undefined;
    const i = ids.indexOf(currentId);
    if (i < 0) return undefined;
    const prev = ids[i - 1];
    const next = ids[i + 1];
    return { prev: prev ? pathOf(prev) : null, next: next ? pathOf(next) : null };
}

import { useMemo } from 'react';
import { useRecordPages } from '../../../api/lists';
import type { BoardView, OpportunityView } from '../../../api/types';
import { encodeFilter } from '../../../lib/filterParam';
import { type DateRange, previousRange } from './reportsData';

/** The deals list API holds at most this many per page; a period is read in one page. */
const PERIOD_LIMIT = 200;

/**
 * The deals a period is judged by, from the list API with a date filter: those that closed in the
 * range (won or lost by their stage) and those created in it — for the range, and for the one
 * before it, so each number can say how it moved.
 */
export interface PeriodDeals {
    won: OpportunityView[];
    lost: OpportunityView[];
    created: OpportunityView[];
    /** Any list is still loading. */
    pending: boolean;
    /** A list holds more than one page: the figures are from what was read. */
    truncated: boolean;
}

function filterFor(field: 'closedAt' | 'createdAt', range: DateRange): string {
    return encodeFilter({
        and: [{ field, op: 'between', value: [range.from.toISOString(), range.to.toISOString()] }],
    });
}

function useDealsBy(workspaceId: string, field: 'closedAt' | 'createdAt', range: DateRange) {
    return useRecordPages(workspaceId, 'opportunity', {
        filter: filterFor(field, range),
        limit: PERIOD_LIMIT,
        sort: `${field}:desc`,
    });
}

export function usePeriodDeals(workspaceId: string, range: DateRange, board: BoardView | undefined): PeriodDeals {
    const closed = useDealsBy(workspaceId, 'closedAt', range);
    const created = useDealsBy(workspaceId, 'createdAt', range);
    return useMemo(() => {
        const kind = new Map((board?.columns ?? []).map((c) => [c.stage.id, c.stage.kind]));
        const closedList = closed.data?.pages.flatMap((p) => p.items) ?? [];
        return {
            won: closedList.filter((d) => kind.get(d.stageId) === 'won'),
            lost: closedList.filter((d) => kind.get(d.stageId) === 'lost'),
            created: created.data?.pages.flatMap((p) => p.items) ?? [],
            pending: closed.isPending || created.isPending || board === undefined,
            truncated: Boolean(closed.hasNextPage || created.hasNextPage),
        };
    }, [
        board,
        closed.data,
        closed.isPending,
        closed.hasNextPage,
        created.data,
        created.isPending,
        created.hasNextPage,
    ]);
}

/** This period and the one before it, side by side. */
export function usePeriodComparison(workspaceId: string, range: DateRange, board: BoardView | undefined) {
    const before = useMemo(() => previousRange(range), [range]);
    return { now: usePeriodDeals(workspaceId, range, board), before: usePeriodDeals(workspaceId, before, board) };
}

/** Whole days from creation to close, averaged. */
export function cycleDays(closed: readonly OpportunityView[]): number | null {
    const list = closed.filter((d) => d.closedAt);
    if (list.length === 0) return null;
    const days = list.map((d) => (new Date(d.closedAt!).getTime() - new Date(d.createdAt).getTime()) / 86_400_000);
    return Math.round(days.reduce((a, b) => a + b, 0) / list.length);
}

/** The sum of the amounts in a currency, in minor units. */
export function amountMinor(list: readonly OpportunityView[], currency: string): number {
    return list.reduce((n, d) => n + (d.amount?.currency === currency ? d.amount.amountMinor : 0), 0);
}

import type { BoardColumn, BoardView, OpportunityView } from '../../../api/types';

/**
 * Everything the reports page derives from the default pipeline's board. The counts and sums per
 * stage are the API's and exact; the lists, months and sources come from the cards the board
 * loaded (its first page per stage), which the page says beside each figure.
 */

export interface Money {
    amountMinor: number;
    currency: string;
}

/** The board's one currency: the first a deal names, or the workspace's usual dollar. */
export function boardCurrency(board: BoardView | undefined): string {
    for (const column of board?.columns ?? []) {
        for (const currency of Object.keys(column.amountMinorByCurrency)) return currency;
        for (const deal of column.deals) return deal.amount?.currency ?? deal.currency;
    }
    return 'USD';
}

/** The exact sum of the columns in the board's currency (other currencies are left out). */
export function sumOf(columns: readonly BoardColumn[], currency: string): Money {
    let amountMinor = 0;
    for (const column of columns) amountMinor += column.amountMinorByCurrency[currency] ?? 0;
    return { amountMinor, currency };
}

export const open = (board: BoardView | undefined) => (board?.columns ?? []).filter((c) => c.stage.kind === 'open');
export const won = (board: BoardView | undefined) => (board?.columns ?? []).filter((c) => c.stage.kind === 'won');
export const lost = (board: BoardView | undefined) => (board?.columns ?? []).filter((c) => c.stage.kind === 'lost');
export const count = (columns: readonly BoardColumn[]) => columns.reduce((n, c) => n + c.count, 0);
export const deals = (columns: readonly BoardColumn[]) => columns.flatMap((c) => c.deals);

/** A deal's probability: its own, else its stage's. */
export function probabilityOf(deal: OpportunityView, board: BoardView | undefined): number {
    if (deal.probability !== null && deal.probability !== undefined) return deal.probability;
    return board?.columns.find((c) => c.stage.id === deal.stageId)?.stage.probability ?? 0;
}

/** Value × probability, summed over the open deals the board loaded. */
export function forecast(board: BoardView | undefined, currency: string): Money {
    let amountMinor = 0;
    for (const deal of deals(open(board))) {
        if (deal.amount?.currency === currency)
            amountMinor += Math.round((deal.amount.amountMinor * probabilityOf(deal, board)) / 100);
    }
    return { amountMinor, currency };
}

/** Won over won plus lost, in percent, from the exact column counts; null with nothing closed. */
export function winRate(board: BoardView | undefined): number | null {
    const w = count(won(board));
    const l = count(lost(board));
    return w + l === 0 ? null : Math.round((w / (w + l)) * 100);
}

/** Whole days from a deal's creation to its close, averaged over the closed deals loaded. */
export function averageCycleDays(board: BoardView | undefined): number | null {
    const closed = deals([...won(board), ...lost(board)]).filter((d) => d.closedAt);
    if (closed.length === 0) return null;
    const days = closed.map((d) => (new Date(d.closedAt!).getTime() - new Date(d.createdAt).getTime()) / 86_400_000);
    return Math.round(days.reduce((a, b) => a + b, 0) / closed.length);
}

export function averageDaysInStage(board: BoardView | undefined): number {
    const list = deals(open(board));
    return list.length ? Math.round(list.reduce((n, d) => n + d.daysInStage, 0) / list.length) : 0;
}

/** Open deals whose cadence is overdue, or that have sat past their stage's threshold. */
export function atRisk(board: BoardView | undefined): OpportunityView[] {
    return open(board).flatMap((c) =>
        c.deals.filter(
            (d) =>
                d.cadenceOverdue ||
                (c.stage.daysThreshold !== null &&
                    c.stage.daysThreshold !== undefined &&
                    d.daysInStage > c.stage.daysThreshold),
        ),
    );
}

/** The last `n` calendar months, oldest first, as `YYYY-MM` keys with short labels. */
export function lastMonths(n: number, now = new Date()): { key: string; label: string }[] {
    const out: { key: string; label: string }[] = [];
    for (let i = n - 1; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        out.push({
            key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
            label: d.toLocaleString(undefined, { month: 'short' }),
        });
    }
    return out;
}

const monthKey = (iso: string) => iso.slice(0, 7);

/** How many of the deals fall in each month by the given date, and their value in the currency. */
export function byMonth(
    list: readonly OpportunityView[],
    dateOf: (d: OpportunityView) => string | null,
    months: readonly { key: string }[],
    currency: string,
): { counts: number[]; amounts: number[] } {
    const counts = months.map(() => 0);
    const amounts = months.map(() => 0);
    for (const deal of list) {
        const date = dateOf(deal);
        if (!date) continue;
        const i = months.findIndex((m) => m.key === monthKey(date));
        if (i < 0) continue;
        counts[i]! += 1;
        if (deal.amount?.currency === currency) amounts[i]! += deal.amount.amountMinor;
    }
    return { counts, amounts };
}

/** Percent change from `before` to `after`; null when there is nothing to compare against. */
export function percentChange(before: number, after: number): number | null {
    if (before === 0) return null;
    return Math.round(((after - before) / before) * 1000) / 10;
}

/** Deals grouped by lead source, largest first, the unnamed ones as "Unknown". */
export function bySource(list: readonly OpportunityView[]): { label: string; value: number }[] {
    const map = new Map<string, number>();
    for (const d of list) {
        const key = d.leadSource?.trim() || 'Unknown';
        map.set(key, (map.get(key) ?? 0) + 1);
    }
    return [...map.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
}

/** Won deals per owner, most first; `null` owner is "Unassigned". */
export function wonByOwner(
    board: BoardView | undefined,
): { id: string; name: string; won: number; amountMinor: number }[] {
    const map = new Map<string, { id: string; name: string; won: number; amountMinor: number }>();
    for (const d of deals(won(board))) {
        const id = d.owner?.memberId ?? 'unassigned';
        const row = map.get(id) ?? { id, name: d.owner?.name ?? 'Unassigned', won: 0, amountMinor: 0 };
        row.won += 1;
        row.amountMinor += d.amount?.amountMinor ?? 0;
        map.set(id, row);
    }
    return [...map.values()].sort((a, b) => b.won - a.won || b.amountMinor - a.amountMinor);
}

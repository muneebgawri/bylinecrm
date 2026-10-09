import { ChevronDown, Columns3, Filter, ListFilter, MoreHorizontal, Search } from 'lucide-react';
import { forwardRef, useId, type HTMLAttributes, type ReactNode } from 'react';
import { useIsMobile } from '../../lib/breakpoints';
import { cn } from '../../lib/cn';
import { focusRing } from '../../lib/focus';
import { Button } from '../button/Button';
import { CardList, type CardListItem } from '../card-list/CardList';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuTrigger,
} from '../dropdown-menu/DropdownMenu';
import { Skeleton } from '../skeleton/Skeleton';

export interface TableTab<T extends string = string> {
    id: T;
    label: string;
    count?: number | undefined;
}

export interface TableToolbar {
    onFilter?: () => void;
    onSort?: () => void;
    onColumns?: () => void;
    /** Anything else after the three buttons. */
    extra?: ReactNode;
}

export interface TableSearch {
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
}

export interface TablePagination {
    /** 1-based. */
    page: number;
    pageCount: number;
    onPageChange: (page: number) => void;
    pageSize: number;
    pageSizes?: readonly number[];
    onPageSizeChange?: (size: number) => void;
    /** "2 of 50 rows selected" — shown between the page count and the size picker. */
    selectionLabel?: ReactNode;
}

/**
 * Where a column goes when the table becomes cards on a phone (doc 48 FR-CRMS-UI-12):
 * `primary` the card's name line, `secondary` the muted line under it, `meta` stacked at the card's
 * end, `hidden` not on the card. Unset, the first column is primary, the next two secondary and
 * the rest hidden — so a page gets a sensible card by declaring nothing.
 */
export type PhoneRole = 'primary' | 'secondary' | 'meta' | 'hidden';

export interface TableColumn<R> {
    id: string;
    /** The column heading on a desktop. Plain text: it is also the cell's name for a screen reader. */
    header: string;
    cell: (row: R) => ReactNode;
    phone?: PhoneRole;
    /** Quiet text (dates, counts). */
    muted?: boolean;
    className?: string;
}

export interface TableRowActions<R> {
    /** Names the row in the menu button's label: "Actions for Dana Reyes". */
    label: (row: R) => string;
    /** The menu's items (`DropdownMenuItem`s and friends), or `null` when the row has none. */
    items: (row: R) => ReactNode;
}

/** The rows drawn by the chrome itself: a table on a desktop, cards on a phone, from one definition. */
export interface TableData<R> {
    columns: readonly TableColumn<R>[];
    rows: readonly R[];
    getRowId: (row: R) => string;
    /** One "•••" menu per row, at the row's end on a desktop and on the card on a phone. */
    rowActions?: TableRowActions<R>;
    /** An avatar or icon at the start of a phone card. */
    leading?: (row: R) => ReactNode;
    /** Names the phone card list ("Members"). */
    label: string;
    loading?: boolean;
    /** Shown instead of rows when there are none (and not loading). */
    empty?: ReactNode;
    /**
     * `auto` (the default): cards below `BREAKPOINT_PX.mobile`, a table above. `table` and `cards`
     * force one, for a story or test rendered at a fixed width.
     */
    layout?: 'auto' | 'table' | 'cards';
}

/** The phone role of each column: its own, or the default by position. */
export function phoneRoles<R>(columns: readonly TableColumn<R>[]): PhoneRole[] {
    return columns.map((c, i) => c.phone ?? (i === 0 ? 'primary' : i <= 2 ? 'secondary' : 'hidden'));
}

export interface DataTableChromeProps<T extends string = string, R = unknown> extends Omit<
    HTMLAttributes<HTMLDivElement>,
    'title'
> {
    tabs?: readonly TableTab<T>[];
    activeTab?: T;
    onTabChange?: (id: T) => void;
    search?: TableSearch;
    toolbar?: TableToolbar;
    pagination?: TablePagination;
    /**
     * A footer of the caller's own, for a list that is not paged by number — a cursor list that
     * loads as it scrolls says "120 shown · loading more" here. Ignored when `pagination` is set.
     */
    footer?: ReactNode;
    /**
     * Rows the chrome draws itself — a table on a desktop and `CardList` cards on a phone. Use this
     * for every ordinary table, so no page can show a table on a phone.
     */
    data?: TableData<R>;
    /**
     * A body of the caller's own, for a list the chrome cannot draw (a virtualised record list,
     * which renders its own `CardList` on a phone). Ignored when `data` is set.
     */
    children?: ReactNode;
}

const DEFAULT_PAGE_SIZES = [25, 50, 100] as const;

/** The pages shown as buttons: the current one with a neighbour each side, clamped to the range. */
export function pageWindow(page: number, pageCount: number, width = 3): number[] {
    const start = Math.max(1, Math.min(page - 1, pageCount - width + 1));
    return Array.from({ length: Math.min(width, pageCount) }, (_, i) => start + i);
}

function DataTableChromeInner<T extends string, R>(
    {
        className,
        tabs,
        activeTab,
        onTabChange,
        search,
        toolbar,
        pagination,
        footer,
        data,
        children,
        ...props
    }: DataTableChromeProps<T, R>,
    ref: React.ForwardedRef<HTMLDivElement>,
) {
    const searchId = useId();
    const hasTop = Boolean(tabs?.length || search || toolbar);
    return (
        <div
            ref={ref}
            className={cn('overflow-hidden rounded-lg border border-border bg-surface shadow-sm', className)}
            {...props}
        >
            {hasTop && (
                <div className="flex flex-wrap items-center gap-2 border-b border-border px-4.5 py-3">
                    {tabs && tabs.length > 0 && (
                        <div role="tablist" aria-label="Rows" className="flex max-w-full gap-1 overflow-x-auto">
                            {tabs.map((tab) => {
                                const active = tab.id === activeTab;
                                return (
                                    <button
                                        key={tab.id}
                                        type="button"
                                        role="tab"
                                        aria-selected={active}
                                        onClick={() => onTabChange?.(tab.id)}
                                        className={cn(
                                            'h-8 shrink-0 rounded-md border border-transparent px-3 font-medium text-text-muted transition-colors max-md:h-touch',
                                            active && 'border-border bg-surface-raised text-text',
                                            focusRing,
                                        )}
                                    >
                                        {tab.label}
                                        {tab.count !== undefined && (
                                            <span className="ml-1.5 text-xs text-text-faint tabular-nums">
                                                {tab.count.toLocaleString()}
                                            </span>
                                        )}
                                    </button>
                                );
                            })}
                        </div>
                    )}
                    <div className="ml-auto flex flex-wrap items-center gap-2">
                        {search && (
                            <label
                                htmlFor={searchId}
                                className="flex h-8.5 min-w-55 items-center gap-2 rounded-md border border-border bg-surface px-3 text-text-faint focus-within:ring-2 focus-within:ring-ring max-md:h-auto max-md:min-w-0 max-md:flex-1"
                            >
                                <Search aria-hidden className="size-3.75 shrink-0" />
                                <input
                                    id={searchId}
                                    type="search"
                                    value={search.value}
                                    onChange={(e) => search.onChange(e.target.value)}
                                    placeholder={search.placeholder ?? 'Search…'}
                                    aria-label={search.placeholder ?? 'Search'}
                                    className="w-full bg-transparent text-sm text-text outline-none placeholder:text-text-faint max-md:min-h-touch max-md:text-touch"
                                />
                            </label>
                        )}
                        {toolbar?.onFilter && (
                            <Button size="sm" shape="square" onClick={toolbar.onFilter}>
                                <Filter aria-hidden /> Filter
                            </Button>
                        )}
                        {toolbar?.onSort && (
                            <Button size="sm" shape="square" onClick={toolbar.onSort}>
                                <ListFilter aria-hidden /> Sort
                            </Button>
                        )}
                        {toolbar?.onColumns && (
                            <Button size="sm" shape="square" onClick={toolbar.onColumns}>
                                <Columns3 aria-hidden /> Columns
                            </Button>
                        )}
                        {toolbar?.extra}
                    </div>
                </div>
            )}
            {/* `relative`: an absolutely positioned cell part (an sr-only label) would otherwise escape this
                scroll container and widen the whole page. */}
            {data ? <DataBody data={data} /> : <div className="relative overflow-x-auto">{children}</div>}
            {pagination ? (
                <Footer {...pagination} />
            ) : (
                footer && (
                    <div className="flex flex-wrap items-center gap-3.5 border-t border-border px-4.5 py-3 text-[13px] text-text-muted">
                        {footer}
                    </div>
                )
            )}
        </div>
    );
}

function DataBody<R>({ data }: { data: TableData<R> }) {
    const mobile = useIsMobile();
    const cards = data.layout === 'cards' || (data.layout !== 'table' && mobile);
    if (data.loading) {
        return (
            <div className="grid gap-3 p-4" role="status" aria-label="Loading" aria-busy="true">
                <Skeleton className="h-9" />
                <Skeleton className="h-9" />
                <Skeleton className="h-9" />
            </div>
        );
    }
    if (data.rows.length === 0) return <>{data.empty}</>;
    return cards ? <DataCards data={data} /> : <DataTable data={data} />;
}

/**
 * A row's one "•••" menu — the table's row end, a phone card's action, and any list that draws its
 * own cards (the deals list) — so a row's actions are offered the same way everywhere.
 */
export function RowActionsMenu<R>({ actions, row }: { actions: TableRowActions<R>; row: R }) {
    const items = actions.items(row);
    if (items === null || items === undefined || items === false) return null;
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" shape="square" aria-label={`Actions for ${actions.label(row)}`}>
                    <MoreHorizontal aria-hidden />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">{items}</DropdownMenuContent>
        </DropdownMenu>
    );
}

function DataTable<R>({ data }: { data: TableData<R> }) {
    return (
        // `relative`: an absolutely positioned cell part (an sr-only label) would otherwise escape
        // this scroll container and widen the whole page.
        <div className="relative overflow-x-auto">
            <table className={tableClasses.table}>
                <thead>
                    <tr>
                        {data.columns.map((c) => (
                            <th key={c.id} scope="col" className={tableClasses.th}>
                                {c.header}
                            </th>
                        ))}
                        {data.rowActions && (
                            <th scope="col" className={tableClasses.th}>
                                <span className="sr-only">Actions</span>
                            </th>
                        )}
                    </tr>
                </thead>
                <tbody>
                    {data.rows.map((row) => (
                        <tr key={data.getRowId(row)} className={tableClasses.tr}>
                            {data.columns.map((c) => (
                                <td
                                    key={c.id}
                                    className={cn(tableClasses.td, c.muted && tableClasses.muted, c.className)}
                                >
                                    {c.cell(row)}
                                </td>
                            ))}
                            {data.rowActions && (
                                <td className={cn(tableClasses.td, 'text-right')}>
                                    <RowActionsMenu actions={data.rowActions} row={row} />
                                </td>
                            )}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

function DataCards<R>({ data }: { data: TableData<R> }) {
    const roles = phoneRoles(data.columns);
    const slot = (row: R, role: PhoneRole) =>
        data.columns.flatMap((c, i) => (roles[i] === role ? [<span key={c.id}>{c.cell(row)}</span>] : []));
    const items: CardListItem[] = data.rows.map((row) => {
        const primary = slot(row, 'primary');
        const actions = data.rowActions ? <RowActionsMenu actions={data.rowActions} row={row} /> : undefined;
        return {
            id: data.getRowId(row),
            leading: data.leading?.(row),
            primary: primary.length > 1 ? <>{primary}</> : primary[0],
            secondary: slot(row, 'secondary'),
            meta: slot(row, 'meta'),
            ...(actions ? { actions } : {}),
        };
    });
    return <CardList aria-label={data.label} items={items} className="p-3" />;
}

function Footer({
    page,
    pageCount,
    onPageChange,
    pageSize,
    pageSizes = DEFAULT_PAGE_SIZES,
    onPageSizeChange,
    selectionLabel,
}: TablePagination) {
    const pages = pageWindow(page, pageCount);
    const go = (next: number) => next >= 1 && next <= pageCount && next !== page && onPageChange(next);
    return (
        <nav
            aria-label="Pagination"
            className="flex flex-wrap items-center gap-3.5 border-t border-border px-4.5 py-3 text-[13px] text-text-muted"
        >
            <span>
                Page {page} of {pageCount}
            </span>
            {selectionLabel && <span>{selectionLabel}</span>}
            <span className="flex items-center gap-1">
                Rows per page
                {onPageSizeChange ? (
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <button
                                type="button"
                                className={cn(
                                    'inline-flex items-center gap-0.5 rounded-sm px-1 font-semibold text-text max-md:min-h-touch max-md:min-w-touch',
                                    focusRing,
                                )}
                            >
                                {pageSize}
                                <ChevronDown aria-hidden className="size-3.5" />
                            </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start">
                            <DropdownMenuRadioGroup
                                value={String(pageSize)}
                                onValueChange={(v) => onPageSizeChange(Number(v))}
                            >
                                {pageSizes.map((size) => (
                                    <DropdownMenuRadioItem key={size} value={String(size)}>
                                        {size}
                                    </DropdownMenuRadioItem>
                                ))}
                            </DropdownMenuRadioGroup>
                        </DropdownMenuContent>
                    </DropdownMenu>
                ) : (
                    <b className="font-semibold text-text">{pageSize}</b>
                )}
            </span>
            <div className="ml-auto flex items-center gap-1.5">
                <PageButton onClick={() => go(page - 1)} disabled={page <= 1}>
                    Previous
                </PageButton>
                {pages.map((n) => (
                    <PageButton key={n} onClick={() => go(n)} current={n === page} aria-label={`Page ${n}`}>
                        {n}
                    </PageButton>
                ))}
                <PageButton onClick={() => go(page + 1)} disabled={page >= pageCount}>
                    Next
                </PageButton>
            </div>
        </nav>
    );
}

function PageButton({
    current = false,
    className,
    ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { current?: boolean }) {
    return (
        <button
            type="button"
            aria-current={current ? 'page' : undefined}
            className={cn(
                'grid h-7.5 min-w-7.5 place-items-center rounded-md px-1.5 text-text-muted transition-colors hover:bg-surface-raised hover:text-text max-md:h-touch max-md:min-w-touch',
                'disabled:pointer-events-none disabled:opacity-50',
                current && 'bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground',
                focusRing,
                className,
            )}
            {...props}
        />
    );
}

/**
 * Everything around a table: the tab row with counts, search, Filter / Sort / Columns, the rows,
 * and the footer with "Page x of y · rows per page · Previous 1 2 3 Next". Rows given as `data`
 * are drawn as a table on a desktop and as cards on a phone; `children` is for a body the caller
 * draws itself.
 */
export const DataTableChrome = forwardRef(DataTableChromeInner) as <T extends string = string, R = unknown>(
    props: DataTableChromeProps<T, R> & { ref?: React.ForwardedRef<HTMLDivElement> },
) => React.ReactElement;

/** Table primitives styled to the chrome: raised header row, hover rows, selection tint. */
export const tableClasses = {
    table: 'w-full min-w-max border-collapse text-sm',
    th: 'whitespace-nowrap border-b border-border bg-surface-raised px-4.5 py-2.5 text-left text-[12.5px] font-medium text-text-muted',
    td: 'whitespace-nowrap border-b border-border px-4.5 py-3 align-middle group-last:border-b-0',
    tr: 'group hover:[&>td]:bg-surface-raised data-[selected=true]:[&>td]:bg-selection',
    muted: 'text-text-muted',
} as const;

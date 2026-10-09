import { ChevronDown, Columns3, Filter, ListFilter, Search } from 'lucide-react';
import { forwardRef, useId, type HTMLAttributes, type ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { focusRing } from '../../lib/focus';
import { Button } from '../button/Button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuTrigger,
} from '../dropdown-menu/DropdownMenu';

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

export interface DataTableChromeProps<T extends string = string> extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
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
    /** The table itself; it scrolls horizontally inside the chrome. */
    children: ReactNode;
}

const DEFAULT_PAGE_SIZES = [25, 50, 100] as const;

/** The pages shown as buttons: the current one with a neighbour each side, clamped to the range. */
export function pageWindow(page: number, pageCount: number, width = 3): number[] {
    const start = Math.max(1, Math.min(page - 1, pageCount - width + 1));
    return Array.from({ length: Math.min(width, pageCount) }, (_, i) => start + i);
}

function DataTableChromeInner<T extends string>(
    {
        className,
        tabs,
        activeTab,
        onTabChange,
        search,
        toolbar,
        pagination,
        footer,
        children,
        ...props
    }: DataTableChromeProps<T>,
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
            <div className="relative overflow-x-auto">{children}</div>
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
 * Everything around a table: the tab row with counts, search, Filter / Sort / Columns, and the
 * footer with "Page x of y · rows per page · Previous 1 2 3 Next". The rows are the caller's.
 */
export const DataTableChrome = forwardRef(DataTableChromeInner) as <T extends string = string>(
    props: DataTableChromeProps<T> & { ref?: React.ForwardedRef<HTMLDivElement> },
) => React.ReactElement;

/** Table primitives styled to the chrome: raised header row, hover rows, selection tint. */
export const tableClasses = {
    table: 'w-full min-w-max border-collapse text-sm',
    th: 'whitespace-nowrap border-b border-border bg-surface-raised px-4.5 py-2.5 text-left text-[12.5px] font-medium text-text-muted',
    td: 'whitespace-nowrap border-b border-border px-4.5 py-3 align-middle group-last:border-b-0',
    tr: 'group hover:[&>td]:bg-surface-raised data-[selected=true]:[&>td]:bg-selection',
    muted: 'text-text-muted',
} as const;

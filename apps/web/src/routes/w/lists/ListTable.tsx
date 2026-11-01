import type { ViewSort } from '@bylinecrm/shared';
import {
    AvatarCell,
    Button,
    Checkbox,
    cn,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
    focusRing,
    tableClasses,
} from '@bylinecrm/ui';
import {
    flexRender,
    getCoreRowModel,
    useReactTable,
    type ColumnDef,
    type ColumnSizingState,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown, ArrowUp, ArrowUpDown, MoreHorizontal } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type RefObject } from 'react';
import { personName, type ListColumn, type ListObject, type ListRow } from './listConfig';
import { isSortable } from './listConfig';

/** Row height the virtualiser starts from; real rows are measured. */
const ROW_ESTIMATE_PX = 52;
/** How many rows from the end a scroll must reach before the next page is asked for. */
const FETCH_AHEAD_ROWS = 15;
const SELECT_WIDTH = 44;
const INITIAL_RECT = { width: 1024, height: 800 };
const ACTIONS_WIDTH = 52;

export interface ListTableProps<O extends ListObject> {
    object: O;
    rows: readonly ListRow<O>[];
    columns: readonly { column: ListColumn<ListRow<O>>; width: number }[];
    sorts: readonly ViewSort[];
    onSortColumn: (field: string) => void;
    selected: ReadonlySet<string>;
    onToggle: (id: string) => void;
    onToggleAll: () => void;
    /** A click opens the drawer; a modified click (or "Open") the full page. */
    onOpen: (row: ListRow<O>, fullPage: boolean) => void;
    onResize: (field: string, width: number) => void;
    hasMore: boolean;
    loadingMore: boolean;
    onMore: () => void;
    canWrite: boolean;
    writeReason: string;
    onAssign: (ids: string[]) => void;
    onDelete: (ids: string[]) => void;
}

/**
 * The desktop list (FR-CRMS-UI-1): TanStack Table for the columns (order, visibility and width
 * come from the view), TanStack Virtual for the rows, so 100,000 rows cost what 30 do. Sorting is
 * the server's: a header click changes the URL, never reorders the loaded rows. The next page is
 * asked for as the scroll nears the end (the API pages by cursor; the page footer shows the total).
 */
export function ListTable<O extends ListObject>(props: ListTableProps<O>) {
    const { object, rows, columns, sorts, selected, hasMore, loadingMore, onMore, onResize } = props;
    const scrollRef = useRef<HTMLDivElement>(null);
    const [sizing, setSizing] = useState<ColumnSizingState>({});
    const widths = useMemo(() => Object.fromEntries(columns.map((c) => [c.column.field, c.width])), [columns]);

    const defs = useMemo<ColumnDef<ListRow<O>>[]>(
        () => [
            { id: '__select', size: SELECT_WIDTH, enableResizing: false },
            ...columns.map<ColumnDef<ListRow<O>>>(({ column, width }) => ({
                id: column.field,
                header: column.label,
                size: width,
                minSize: 80,
            })),
            { id: '__actions', size: ACTIONS_WIDTH, enableResizing: false },
        ],
        [columns],
    );

    const table = useReactTable({
        data: rows as ListRow<O>[],
        columns: defs,
        getRowId: (row) => row.id,
        getCoreRowModel: getCoreRowModel(),
        columnResizeMode: 'onChange',
        state: { columnSizing: sizing },
        onColumnSizingChange: setSizing,
    });

    // A finished resize is a column width the view can save: act on the change from "resizing a
    // column" to "not resizing", once, with that column's final width.
    const resizing = table.getState().columnSizingInfo.isResizingColumn;
    const wasResizing = useRef<string | false>(false);
    useEffect(() => {
        const field = wasResizing.current;
        wasResizing.current = resizing;
        if (resizing || !field) return;
        const width = sizing[field];
        if (width && width !== widths[field]) onResize(field, Math.round(width));
    }, [resizing, sizing, widths, onResize]);

    const tableRows = table.getRowModel().rows;
    const virtualizer = useVirtualizer({
        count: tableRows.length,
        getScrollElement: () => scrollRef.current,
        estimateSize: () => ROW_ESTIMATE_PX,
        overscan: 10,
        // Until the container is measured, assume a screenful — so the first rows render at once
        // (and in an environment with no layout at all) rather than after the first resize event.
        initialRect: INITIAL_RECT,
    });
    const items = virtualizer.getVirtualItems();
    const last = items.at(-1);

    useEffect(() => {
        if (last && last.index >= tableRows.length - FETCH_AHEAD_ROWS && hasMore && !loadingMore) onMore();
    }, [last, tableRows.length, hasMore, loadingMore, onMore]);

    const allChosen = rows.length > 0 && rows.every((r) => selected.has(r.id));
    const someChosen = !allChosen && rows.some((r) => selected.has(r.id));
    const padTop = items[0]?.start ?? 0;
    const padBottom = last ? virtualizer.getTotalSize() - last.end : 0;
    // The columns fill the card (P1-UI-10): when they add up to less than the space there is, the
    // last data column takes the rest, so no empty band sits right of the row menu. A saved width
    // is still the column's own; the spare space is only added when drawing.
    const available = useElementWidth(scrollRef);
    const spare = Math.max(0, available - table.getTotalSize());
    const lastField = columns.at(-1)?.column.field;
    const widthOf = (id: string, size: number) => (id === lastField ? size + spare : size);
    const totalWidth = table.getTotalSize() + spare;
    // An identity cell's second line repeats nothing already in a column (a company's domain).
    const shown = new Set(columns.map((c) => c.column.field));
    const sortOf = (field: string) => sorts.find((s) => s.field === field);

    return (
        <div ref={scrollRef} className="max-h-[calc(100dvh-17rem)] min-h-64 overflow-auto">
            <table className={cn(tableClasses.table, 'table-fixed')} style={{ width: totalWidth }}>
                <thead className="sticky top-0 z-10">
                    {table.getHeaderGroups().map((group) => (
                        <tr key={group.id}>
                            {group.headers.map((header) => {
                                const id = header.column.id;
                                const style = { width: widthOf(id, header.getSize()) };
                                if (id === '__select') {
                                    return (
                                        <th key={id} className={tableClasses.th} style={style}>
                                            <Checkbox
                                                aria-label="Select all loaded rows"
                                                checked={allChosen ? true : someChosen ? 'indeterminate' : false}
                                                onCheckedChange={props.onToggleAll}
                                            />
                                        </th>
                                    );
                                }
                                if (id === '__actions') {
                                    return (
                                        <th key={id} className={tableClasses.th} style={style}>
                                            <span className="sr-only">Actions</span>
                                        </th>
                                    );
                                }
                                const sort = sortOf(id);
                                const canSort = isSortable(object, id);
                                return (
                                    <th
                                        key={id}
                                        className={cn(tableClasses.th, 'relative')}
                                        style={style}
                                        aria-sort={
                                            sort ? (sort.direction === 'asc' ? 'ascending' : 'descending') : undefined
                                        }
                                    >
                                        {canSort ? (
                                            <button
                                                type="button"
                                                onClick={() => props.onSortColumn(id)}
                                                className={cn(
                                                    'inline-flex items-center gap-1 rounded-sm hover:text-text',
                                                    focusRing,
                                                )}
                                            >
                                                {flexRender(header.column.columnDef.header, header.getContext())}
                                                {sort ? (
                                                    sort.direction === 'asc' ? (
                                                        <ArrowUp aria-hidden className="size-3.5" />
                                                    ) : (
                                                        <ArrowDown aria-hidden className="size-3.5" />
                                                    )
                                                ) : (
                                                    <ArrowUpDown aria-hidden className="size-3.5 text-text-faint" />
                                                )}
                                            </button>
                                        ) : (
                                            flexRender(header.column.columnDef.header, header.getContext())
                                        )}
                                        {header.column.getCanResize() && (
                                            <div
                                                role="separator"
                                                aria-orientation="vertical"
                                                aria-label={`Resize ${String(header.column.columnDef.header)}`}
                                                onMouseDown={header.getResizeHandler()}
                                                onTouchStart={header.getResizeHandler()}
                                                onDoubleClick={() => header.column.resetSize()}
                                                className={cn(
                                                    'absolute top-0 right-0 h-full w-1.5 cursor-col-resize touch-none select-none hover:bg-border-strong',
                                                    header.column.getIsResizing() && 'bg-accent',
                                                )}
                                            />
                                        )}
                                    </th>
                                );
                            })}
                        </tr>
                    ))}
                </thead>
                <tbody>
                    {padTop > 0 && (
                        <tr aria-hidden>
                            <td style={{ height: padTop }} colSpan={defs.length} />
                        </tr>
                    )}
                    {items.map((item) => {
                        const row = tableRows[item.index];
                        if (!row) return null;
                        const record = row.original;
                        const chosen = selected.has(record.id);
                        const open = (e: MouseEvent) => props.onOpen(record, e.metaKey || e.ctrlKey);
                        return (
                            <tr
                                key={row.id}
                                ref={virtualizer.measureElement}
                                data-index={item.index}
                                data-selected={chosen}
                                className={cn(tableClasses.tr, 'cursor-pointer')}
                                onClick={open}
                            >
                                {row.getVisibleCells().map((cell) => {
                                    const id = cell.column.id;
                                    if (id === '__select') {
                                        return (
                                            <td
                                                key={cell.id}
                                                className={tableClasses.td}
                                                onClick={(e) => e.stopPropagation()}
                                            >
                                                <Checkbox
                                                    aria-label={`Select ${identityName(object, record)}`}
                                                    checked={chosen}
                                                    onCheckedChange={() => props.onToggle(record.id)}
                                                />
                                            </td>
                                        );
                                    }
                                    if (id === '__actions') {
                                        return (
                                            <td
                                                key={cell.id}
                                                className={tableClasses.td}
                                                onClick={(e) => e.stopPropagation()}
                                            >
                                                <RowMenu
                                                    name={identityName(object, record)}
                                                    canWrite={props.canWrite}
                                                    writeReason={props.writeReason}
                                                    onOpen={(fullPage) => props.onOpen(record, fullPage)}
                                                    onAssign={() => props.onAssign([record.id])}
                                                    onDelete={() => props.onDelete([record.id])}
                                                />
                                            </td>
                                        );
                                    }
                                    const spec = columns.find((c) => c.column.field === id)?.column;
                                    const identity = cell.column.getIndex() === 1;
                                    return (
                                        <td key={cell.id} className={cn(tableClasses.td, 'max-w-0 truncate')}>
                                            {identity ? (
                                                <AvatarCell
                                                    name={identityName(object, record)}
                                                    src={identityPicture(object, record)}
                                                    subline={tableSubline(object, record, shown)}
                                                    nameAs={(name) => (
                                                        <button
                                                            type="button"
                                                            className={cn('truncate rounded-sm text-left', focusRing)}
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                open(e);
                                                            }}
                                                        >
                                                            {name}
                                                        </button>
                                                    )}
                                                />
                                            ) : (
                                                spec?.cell(record)
                                            )}
                                        </td>
                                    );
                                })}
                            </tr>
                        );
                    })}
                    {padBottom > 0 && (
                        <tr aria-hidden>
                            <td style={{ height: padBottom }} colSpan={defs.length} />
                        </tr>
                    )}
                </tbody>
            </table>
        </div>
    );
}

export function identityName<O extends ListObject>(object: O, row: ListRow<O>): string {
    return object === 'person' ? personName(row as ListRow<'person'>) : (row as ListRow<'company'>).name;
}

/** The person's picture (enrichment fills it, P4-2); a company's row keeps its initials. */
export function identityPicture<O extends ListObject>(object: O, row: ListRow<O>): string | undefined {
    return object === 'person' ? ((row as ListRow<'person'>).avatarUrl ?? undefined) : undefined;
}

/** The identity cell's second line and the field it comes from: a person's title (else address), a company's domain. */
function sublineOf<O extends ListObject>(object: O, row: ListRow<O>): { field: string; text: string } | undefined {
    if (object === 'person') {
        const p = row as ListRow<'person'>;
        if (p.jobTitle) return { field: 'jobTitle', text: p.jobTitle };
        return p.emails.primary ? { field: 'emailPrimary', text: p.emails.primary } : undefined;
    }
    const domain = (row as ListRow<'company'>).domain;
    return domain ? { field: 'domain', text: domain } : undefined;
}

/** A card's second line (phones have no columns, so it is always shown). */
export function identitySubline<O extends ListObject>(object: O, row: ListRow<O>): string | undefined {
    return sublineOf(object, row)?.text;
}

/** The table's: dropped when its field is already a visible column, so nothing is shown twice. */
function tableSubline<O extends ListObject>(
    object: O,
    row: ListRow<O>,
    shown: ReadonlySet<string>,
): string | undefined {
    const subline = sublineOf(object, row);
    return subline && !shown.has(subline.field) ? subline.text : undefined;
}

/** An element's inner width, kept current as it resizes; the offset width where layout has no client box. */
function useElementWidth(ref: RefObject<HTMLElement | null>): number {
    const [width, setWidth] = useState(0);
    useLayoutEffect(() => {
        const element = ref.current;
        if (!element) return;
        const read = () => setWidth(element.clientWidth || element.offsetWidth);
        read();
        const observer = new ResizeObserver(read);
        observer.observe(element);
        return () => observer.disconnect();
    }, [ref]);
    return width;
}

function RowMenu({
    name,
    canWrite,
    writeReason,
    onOpen,
    onAssign,
    onDelete,
}: {
    name: string;
    canWrite: boolean;
    writeReason: string;
    onOpen: (fullPage: boolean) => void;
    onAssign: () => void;
    onDelete: () => void;
}) {
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button size="icon" shape="square" variant="ghost" aria-label={`Actions for ${name}`}>
                    <MoreHorizontal aria-hidden />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => onOpen(true)}>Open</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onOpen(false)}>Open in panel</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem disabled={!canWrite} title={writeReason || undefined} onSelect={onAssign}>
                    Assign owner…
                </DropdownMenuItem>
                <DropdownMenuItem
                    disabled={!canWrite}
                    title={writeReason || undefined}
                    onSelect={onDelete}
                    className="text-danger"
                >
                    Delete…
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

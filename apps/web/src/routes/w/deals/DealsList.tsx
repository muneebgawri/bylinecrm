import type { ViewSort } from '@bylinecrm/shared';
import {
    Badge,
    BulkBar,
    BulkBarAction,
    Button,
    CardList,
    Checkbox,
    cn,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
    EmptyState,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    RowActionsMenu,
    tableClasses,
    toast,
    type CardListItem,
} from '@bylinecrm/ui';
import { createColumnHelper, flexRender, getCoreRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import type { BoardView, OpportunityView, StageView } from '../../../api/types';
import { formatMoney } from '../../../lib/money';
import { isSortable, type ListColumn } from '../lists/listConfig';
import { daysLabel, LANE_FOLD, ROW_ESTIMATE_PX, STAGE_TONES, VIRTUAL_OVERSCAN } from './dealsView';
import { classifyMove } from './moveGate';

export interface DealsListProps {
    board: BoardView;
    canMove: boolean;
    canBulk: boolean;
    canEdit: boolean;
    /**
     * The chosen columns from the shared catalogue (P1-UI-6), the identity column first; the stage
     * and days in stage are the board's own columns and always drawn.
     */
    columns: readonly { column: ListColumn<OpportunityView>; width: number }[];
    /** The list's effective sort; a header click asks for a new one through the URL, never reorders locally. */
    sorts: readonly ViewSort[];
    onSortColumn: (field: string) => void;
    onMove: (deal: OpportunityView, stageId: string) => void;
    /** Opens the page's owner dialog for these deals — one bulk request (P1-4a). */
    onBulkAssign: (ids: string[]) => void;
    /** Exports these deals — one request with an `id in` filter (P1-4a). */
    onBulkExport: (ids: string[]) => void;
    /** Opens the deal's record drawer (a row's name, a tap on a phone card). */
    onOpen: (deal: OpportunityView) => void;
    /** Opens the board's Move-to-stage sheet for a deal — how a phone card moves it. */
    onMoveSheet: (deal: OpportunityView) => void;
    /** A phone (FR-CRMS-UI-12): the rows become the design system's cards (CardList). */
    stacked: boolean;
}

/** A row of the list is a deal with its stage, from the same board result the lanes draw. */
interface Row {
    deal: OpportunityView;
    stage: StageView;
}

const helper = createColumnHelper<Row>();

/**
 * The list twin of the board (FR-CRMS-UI-3): the same result set flattened in stage order, with
 * the stage as an inline select (one more way to call the one move), selection and the bulk bar.
 */
export function DealsList({
    board,
    canMove,
    canBulk,
    canEdit,
    columns: chosen,
    sorts,
    onSortColumn,
    onMove,
    onBulkAssign,
    onBulkExport,
    onOpen,
    onMoveSheet,
    stacked,
}: DealsListProps) {
    const rows = useMemo<Row[]>(
        () => board.columns.flatMap((column) => column.deals.map((deal) => ({ deal, stage: column.stage }))),
        [board.columns],
    );
    const stages = board.pipeline.stages;
    const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
    /** A phone's select mode: taps choose cards instead of opening them. */
    const [selecting, setSelecting] = useState(false);
    const scrollRef = useRef<HTMLDivElement>(null);

    // The select box, the deal's name (a link), its stage, the chosen catalogue columns, days in stage.
    const columns = useMemo<ColumnDef<Row, unknown>[]>(
        () =>
            [
                helper.display({
                    id: 'select',
                    header: () => (
                        <Checkbox
                            aria-label="Select all"
                            checked={
                                rows.length > 0 && selected.size === rows.length
                                    ? true
                                    : selected.size > 0
                                      ? 'indeterminate'
                                      : false
                            }
                            onCheckedChange={(checked) =>
                                setSelected(checked === true ? new Set(rows.map((r) => r.deal.id)) : new Set())
                            }
                            disabled={!canBulk}
                        />
                    ),
                    cell: ({ row }) => (
                        <Checkbox
                            aria-label={`Select ${row.original.deal.name}`}
                            checked={selected.has(row.original.deal.id)}
                            onCheckedChange={(checked) =>
                                setSelected((prev) => {
                                    const next = new Set(prev);
                                    if (checked === true) next.add(row.original.deal.id);
                                    else next.delete(row.original.deal.id);
                                    return next;
                                })
                            }
                            disabled={!canBulk}
                        />
                    ),
                    enableHiding: false,
                }),
                helper.accessor((r) => r.deal.name, {
                    id: 'name',
                    header: 'Deal',
                    cell: ({ row }) => (
                        <button
                            type="button"
                            onClick={() => onOpen(row.original.deal)}
                            className="text-left font-medium hover:underline"
                        >
                            {row.original.deal.name}
                        </button>
                    ),
                    enableHiding: false,
                }),
                helper.accessor((r) => r.stage.name, {
                    id: 'stage',
                    header: 'Stage',
                    cell: ({ row }) =>
                        canMove ? (
                            <Select
                                value={row.original.deal.stageId}
                                onValueChange={(stageId) => {
                                    if (classifyMove(stages, row.original.deal.stageId, stageId).kind !== 'same')
                                        onMove(row.original.deal, stageId);
                                }}
                            >
                                <SelectTrigger className="h-7.5 w-40" aria-label={`Stage of ${row.original.deal.name}`}>
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    {stages.map((stage) => (
                                        <SelectItem key={stage.id} value={stage.id}>
                                            {stage.name}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        ) : (
                            <span className="inline-flex flex-wrap items-center gap-1">
                                <Badge status={STAGE_TONES[row.original.stage.colour]} dot>
                                    {row.original.stage.name}
                                </Badge>
                                {row.original.deal.cadenceOverdue && <Badge status="danger">Overdue</Badge>}
                            </span>
                        ),
                }),
                ...chosen
                    .filter(({ column }) => column.field !== 'name')
                    .map(({ column, width }) =>
                        helper.display({
                            id: column.field,
                            header: column.label,
                            size: width,
                            cell: ({ row }) => column.cell(row.original.deal),
                        }),
                    ),
                helper.accessor((r) => r.deal.daysInStage, {
                    id: 'daysInStage',
                    header: 'In stage',
                    cell: ({ row }) => {
                        const { deal, stage } = row.original;
                        const quiet = stage.daysThreshold !== null && deal.daysInStage > stage.daysThreshold;
                        return (
                            <span className={cn('tabular-nums', quiet && 'text-warning')}>
                                {daysLabel(deal.daysInStage)}
                                {quiet ? ' ⚠' : ''}
                            </span>
                        );
                    },
                }),
            ] as ColumnDef<Row, unknown>[],
        [canBulk, canMove, chosen, onMove, onOpen, rows, selected, stages],
    );

    const table = useReactTable({
        data: rows,
        columns,
        getCoreRowModel: getCoreRowModel(),
        getRowId: (row) => row.deal.id,
    });

    const modelRows = table.getRowModel().rows;
    const virtual = modelRows.length > LANE_FOLD;
    const virtualizer = useVirtualizer({
        count: virtual ? modelRows.length : 0,
        getScrollElement: () => scrollRef.current,
        estimateSize: () => ROW_ESTIMATE_PX,
        overscan: VIRTUAL_OVERSCAN,
    });

    const items = virtualizer.getVirtualItems();
    const lastItem = items[items.length - 1];
    const padTop = items[0]?.start ?? 0;
    const padBottom = lastItem ? virtualizer.getTotalSize() - lastItem.end : 0;
    const columnCount = table.getVisibleLeafColumns().length;

    const head = sorts[0];

    const selectedRows = rows.filter((r) => selected.has(r.deal.id));

    function bulkMove(stageId: string) {
        const stage = stages.find((s) => s.id === stageId);
        if (!stage) return;
        if (stage.kind !== 'open') {
            toast({
                title: 'Close deals one at a time',
                description: `Moving to ${stage.name} records a won amount or a lost reason per deal.`,
                tone: 'warning',
            });
            return;
        }
        for (const row of selectedRows) if (row.deal.stageId !== stageId) onMove(row.deal, stageId);
        setSelected(new Set());
    }

    if (rows.length === 0) {
        return (
            <EmptyState title="No deals in this view" body="Deals appear here as they are created in this pipeline." />
        );
    }

    const toggle = (id: string) =>
        setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });

    const bulkBar = selected.size > 0 && canBulk && (
        <BulkBar count={selected.size} onDiscard={() => setSelected(new Set())}>
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <BulkBarAction disabled={!canMove}>Move to stage</BulkBarAction>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                    {stages.map((stage) => (
                        <DropdownMenuItem key={stage.id} onSelect={() => bulkMove(stage.id)}>
                            {stage.name}
                        </DropdownMenuItem>
                    ))}
                </DropdownMenuContent>
            </DropdownMenu>
            <BulkBarAction
                disabled={!canEdit}
                onClick={() => {
                    onBulkAssign([...selected]);
                    setSelected(new Set());
                }}
            >
                Assign owner
            </BulkBarAction>
            <BulkBarAction onClick={() => onBulkExport([...selected])}>Export selected</BulkBarAction>
        </BulkBar>
    );

    if (stacked) {
        // A phone (FR-CRMS-UI-12): the design system's CardList, the card every list uses on a phone —
        // name, company and amount, the stage and days in it — with one "•••" menu per deal. Moving
        // a deal is the board's Move-to-stage sheet, the one move UI on a phone; a long press or
        // Select chooses deals for the same bulk bar.
        const items: CardListItem[] = rows.map(({ deal, stage }) => {
            const quiet = stage.daysThreshold !== null && deal.daysInStage > stage.daysThreshold;
            return {
                id: deal.id,
                primary: deal.name,
                secondary: [deal.company?.name, deal.amount ? formatMoney(deal.amount) : null].filter(
                    (part): part is string => Boolean(part),
                ),
                meta: [
                    <Badge key="stage" status={STAGE_TONES[stage.colour]} dot>
                        {stage.name}
                    </Badge>,
                    ...(deal.cadenceOverdue
                        ? [
                              <Badge key="overdue" status="danger">
                                  Overdue
                              </Badge>,
                          ]
                        : []),
                    <span key="days" className={cn('text-xs tabular-nums', quiet && 'text-warning')}>
                        {daysLabel(deal.daysInStage)} in stage{quiet ? ' ⚠' : ''}
                    </span>,
                ],
                actions: (
                    <RowActionsMenu
                        row={deal}
                        actions={{
                            label: (d) => d.name,
                            items: (d) => (
                                <>
                                    <DropdownMenuItem onSelect={() => onOpen(d)}>Open</DropdownMenuItem>
                                    {canMove && (
                                        <DropdownMenuItem onSelect={() => onMoveSheet(d)}>
                                            Move to stage…
                                        </DropdownMenuItem>
                                    )}
                                </>
                            ),
                        }}
                    />
                ),
            };
        });
        const byId = new Map(rows.map((r) => [r.deal.id, r.deal]));
        return (
            <div className="flex flex-col gap-2">
                {canBulk && (
                    <div className="flex items-center justify-between">
                        <span className="text-sm text-text-muted">{rows.length} deals</span>
                        <Button
                            shape="square"
                            size="sm"
                            onClick={() => {
                                if (selecting) {
                                    setSelecting(false);
                                    setSelected(new Set());
                                } else setSelecting(true);
                            }}
                        >
                            {selecting ? 'Done' : 'Select'}
                        </Button>
                    </div>
                )}
                <CardList
                    aria-label="Deals"
                    items={items}
                    onOpen={(id) => {
                        const deal = byId.get(id);
                        if (deal) onOpen(deal);
                    }}
                    selecting={selecting}
                    selected={selected}
                    onToggle={toggle}
                    {...(canBulk
                        ? {
                              onStartSelecting: (id: string) => {
                                  setSelecting(true);
                                  toggle(id);
                              },
                          }
                        : {})}
                />
                {bulkBar}
            </div>
        );
    }

    const renderRow = (row: (typeof modelRows)[number]) => (
        <tr
            key={row.id}
            className={tableClasses.tr}
            data-selected={selected.has(row.id) ? 'true' : undefined}
            data-index={row.index}
            ref={virtual ? virtualizer.measureElement : undefined}
        >
            {row.getVisibleCells().map((cell) => (
                <td key={cell.id} className={tableClasses.td}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </td>
            ))}
        </tr>
    );

    return (
        <div className="rounded-lg border border-border bg-surface shadow-sm">
            <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
                <span className="text-sm text-text-muted">{rows.length} deals</span>
            </div>
            <div ref={scrollRef} className="max-h-[calc(100vh-20rem)] overflow-auto">
                <table className={tableClasses.table}>
                    <thead className="sticky top-0 z-10">
                        {table.getHeaderGroups().map((group) => (
                            <tr key={group.id}>
                                {group.headers.map((header) => {
                                    const apiField = isSortable('opportunity', header.column.id)
                                        ? header.column.id
                                        : undefined;
                                    const active = apiField !== undefined && head?.field === apiField;
                                    const sortDir = active ? head?.direction : undefined;
                                    return (
                                        <th key={header.id} className={tableClasses.th}>
                                            {apiField ? (
                                                <button
                                                    type="button"
                                                    onClick={() => onSortColumn(apiField)}
                                                    className="inline-flex items-center gap-1 hover:text-text"
                                                    aria-sort={
                                                        active
                                                            ? sortDir === 'asc'
                                                                ? 'ascending'
                                                                : 'descending'
                                                            : 'none'
                                                    }
                                                >
                                                    {flexRender(header.column.columnDef.header, header.getContext())}
                                                    {active ? (
                                                        sortDir === 'asc' ? (
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
                                        </th>
                                    );
                                })}
                            </tr>
                        ))}
                    </thead>
                    {virtual ? (
                        // The rows stay ordinary table rows so they share the header's columns (an
                        // absolutely positioned row is its own table and loses them); the rows scrolled
                        // past are two spacer rows, as ListTable does.
                        <tbody>
                            {padTop > 0 && (
                                <tr aria-hidden>
                                    <td style={{ height: padTop }} colSpan={columnCount} />
                                </tr>
                            )}
                            {items.map((item) => {
                                const row = modelRows[item.index];
                                return row ? renderRow(row) : null;
                            })}
                            {padBottom > 0 && (
                                <tr aria-hidden>
                                    <td style={{ height: padBottom }} colSpan={columnCount} />
                                </tr>
                            )}
                        </tbody>
                    ) : (
                        <tbody>{modelRows.map((row) => renderRow(row))}</tbody>
                    )}
                </table>
            </div>
            {bulkBar}
        </div>
    );
}

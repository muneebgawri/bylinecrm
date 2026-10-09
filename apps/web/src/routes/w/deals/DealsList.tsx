import { sortableFieldNames } from '@bylinecrm/shared';
import {
    Badge,
    BulkBar,
    BulkBarAction,
    Button,
    Checkbox,
    cn,
    DropdownMenu,
    DropdownMenuCheckboxItem,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuTrigger,
    EmptyState,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    tableClasses,
    toast,
} from '@bylinecrm/ui';
import {
    createColumnHelper,
    flexRender,
    getCoreRowModel,
    useReactTable,
    type VisibilityState,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown, ArrowUp, ArrowUpDown, Columns3, Download } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import type { BoardView, MemberSummaryView, OpportunityView, StageView } from '../../../api/types';
import { formatMoney } from '../../../lib/money';
import { daysLabel, LANE_FOLD, ROW_ESTIMATE_PX, STAGE_TONES, VIRTUAL_OVERSCAN } from './dealsView';
import { classifyMove } from './moveGate';

export interface DealsListProps {
    board: BoardView;
    canMove: boolean;
    canBulk: boolean;
    canEdit: boolean;
    members: readonly MemberSummaryView[];
    membersById: ReadonlyMap<string, string>;
    /** `field:asc|desc` over the API's allowlist, or undefined for the API's default. */
    sort: string | undefined;
    onSortChange: (sort: string | undefined) => void;
    onMove: (deal: OpportunityView, stageId: string) => void;
    onAssign: (deal: OpportunityView, ownerId: string | null) => void;
}

/** The columns the API can sort by: the shared descriptors' sortable set, by the same names (P1-4). */
const SORTABLE: ReadonlySet<string> = new Set(sortableFieldNames('opportunity'));

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
    members,
    membersById,
    sort,
    onSortChange,
    onMove,
    onAssign,
}: DealsListProps) {
    const rows = useMemo<Row[]>(
        () => board.columns.flatMap((column) => column.deals.map((deal) => ({ deal, stage: column.stage }))),
        [board.columns],
    );
    const stages = board.pipeline.stages;
    const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
    const [visibility, setVisibility] = useState<VisibilityState>({});
    const scrollRef = useRef<HTMLDivElement>(null);

    // The helper types each definition by its own value; the array's type is inferred from them.
    const columns = useMemo(
        () => [
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
                cell: ({ row }) => <span className="font-medium">{row.original.deal.name}</span>,
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
                        <Badge status={STAGE_TONES[row.original.stage.colour]} dot>
                            {row.original.stage.name}
                        </Badge>
                    ),
            }),
            helper.accessor((r) => r.deal.amount?.amountMinor ?? null, {
                id: 'amount',
                header: 'Amount',
                cell: ({ row }) => <span className="tabular-nums">{formatMoney(row.original.deal.amount)}</span>,
            }),
            helper.accessor((r) => (r.deal.ownerId ? membersById.get(r.deal.ownerId) : undefined), {
                id: 'owner',
                header: 'Owner',
                cell: ({ getValue }) => getValue() ?? <span className="text-text-faint">Unassigned</span>,
            }),
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
            helper.accessor((r) => r.deal.closeDate, {
                id: 'closeDate',
                header: 'Close date',
                cell: ({ getValue }) => getValue() ?? <span className="text-text-faint">—</span>,
            }),
        ],
        [canBulk, canMove, membersById, onMove, rows, selected, stages],
    );

    const table = useReactTable({
        data: rows,
        columns,
        state: { columnVisibility: visibility },
        onColumnVisibilityChange: setVisibility,
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

    const [sortField, sortDir] = sort?.split(':') ?? [];
    const toggleSort = (apiField: string) => {
        if (sortField !== apiField) onSortChange(`${apiField}:asc`);
        else if (sortDir === 'asc') onSortChange(`${apiField}:desc`);
        else onSortChange(undefined);
    };

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

    function bulkAssign(ownerId: string | null) {
        for (const row of selectedRows) if (row.deal.ownerId !== ownerId) onAssign(row.deal, ownerId);
        setSelected(new Set());
    }

    if (rows.length === 0) {
        return (
            <EmptyState title="No deals in this view" body="Deals appear here as they are created in this pipeline." />
        );
    }

    const renderRow = (row: (typeof modelRows)[number], style?: React.CSSProperties) => (
        <tr
            key={row.id}
            className={tableClasses.tr}
            data-selected={selected.has(row.id) ? 'true' : undefined}
            style={style}
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
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <Button variant="secondary" size="sm" shape="square" className="ml-auto">
                            <Columns3 aria-hidden /> Columns
                        </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                        <DropdownMenuLabel>Show columns</DropdownMenuLabel>
                        {table
                            .getAllLeafColumns()
                            .filter((c) => c.getCanHide())
                            .map((column) => (
                                <DropdownMenuCheckboxItem
                                    key={column.id}
                                    checked={column.getIsVisible()}
                                    onCheckedChange={(value) => column.toggleVisibility(value === true)}
                                >
                                    {String(column.columnDef.header)}
                                </DropdownMenuCheckboxItem>
                            ))}
                    </DropdownMenuContent>
                </DropdownMenu>
            </div>
            <div ref={scrollRef} className="max-h-[calc(100vh-20rem)] overflow-auto">
                <table className={tableClasses.table}>
                    <thead className="sticky top-0 z-10">
                        {table.getHeaderGroups().map((group) => (
                            <tr key={group.id}>
                                {group.headers.map((header) => {
                                    const apiField = SORTABLE.has(header.column.id) ? header.column.id : undefined;
                                    const active = apiField !== undefined && sortField === apiField;
                                    return (
                                        <th key={header.id} className={tableClasses.th}>
                                            {apiField ? (
                                                <button
                                                    type="button"
                                                    onClick={() => toggleSort(apiField)}
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
                        <tbody style={{ height: virtualizer.getTotalSize(), position: 'relative', display: 'block' }}>
                            {virtualizer.getVirtualItems().map((item) => {
                                const row = modelRows[item.index];
                                return row
                                    ? renderRow(row, {
                                          position: 'absolute',
                                          top: 0,
                                          left: 0,
                                          width: '100%',
                                          display: 'table',
                                          tableLayout: 'fixed',
                                          transform: `translateY(${item.start}px)`,
                                      })
                                    : null;
                            })}
                        </tbody>
                    ) : (
                        <tbody>{modelRows.map((row) => renderRow(row))}</tbody>
                    )}
                </table>
            </div>
            {selected.size > 0 && canBulk && (
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
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <BulkBarAction disabled={!canEdit}>Assign owner</BulkBarAction>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start">
                            <DropdownMenuItem onSelect={() => bulkAssign(null)}>Unassigned</DropdownMenuItem>
                            {members.map((m) => (
                                <DropdownMenuItem key={m.memberId} onSelect={() => bulkAssign(m.memberId)}>
                                    {m.name ?? 'Member'}
                                </DropdownMenuItem>
                            ))}
                        </DropdownMenuContent>
                    </DropdownMenu>
                    <BulkBarAction disabled title="Export arrives with saved views (P1-4)">
                        <Download aria-hidden /> Export
                    </BulkBarAction>
                </BulkBar>
            )}
        </div>
    );
}

import {
    DndContext,
    DragOverlay,
    PointerSensor,
    useDraggable,
    useDroppable,
    useSensor,
    useSensors,
    type DragEndEvent,
    type DragStartEvent,
} from '@dnd-kit/core';
import { Badge, Button, CardChip, cn, DealCard, EmptyState, KanbanBoard, KanbanLane } from '@bylinecrm/ui';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Clock, MoreHorizontal } from 'lucide-react';
import { useCallback, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { BoardColumn, BoardView, OpportunityView, StageView } from '../../../api/types';
import { formatMoney, formatSums } from '../../../lib/money';
import { CARD_ESTIMATE_PX, daysLabel, LANE_FOLD, STAGE_TONES, VIRTUAL_OVERSCAN } from './dealsView';
import { laneAfterKey } from './moveGate';

export interface DealsBoardProps {
    board: BoardView;
    /** `deal:move` — without it cards are read-only: no drag, no keyboard pick-up. */
    canMove: boolean;
    membersById: ReadonlyMap<string, string>;
    onMove: (deal: OpportunityView, stageId: string) => void;
    /** Text for the page's live region (FR-CRMS-UI-8). */
    announce: (text: string) => void;
    /** Switches to the list rendering, for a lane that holds more than the board carries. */
    onShowList: () => void;
}

interface Picked {
    deal: OpportunityView;
    fromLane: number;
    targetLane: number;
}

/** How far the pointer travels before a press becomes a drag, so a click still opens the deal. */
const DRAG_DISTANCE_PX = 6;

/**
 * The board: lanes from the API's columns, drag between lanes with dnd-kit, and a keyboard twin
 * that needs no pointer — Space picks up, ←/→ choose a lane, Space drops, Escape cancels — with
 * every step announced (doc 50 §B). Counts and sums are the API's for the current filter.
 */
export function DealsBoard({ board, canMove, membersById, onMove, announce, onShowList }: DealsBoardProps) {
    const [active, setActive] = useState<OpportunityView | null>(null);
    const [picked, setPicked] = useState<Picked | null>(null);
    const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: DRAG_DISTANCE_PX } }));
    const columns = board.columns;
    const stageNames = useMemo(() => columns.map((c) => c.stage.name), [columns]);

    const onDragStart = useCallback((event: DragStartEvent) => {
        setActive((event.active.data.current as { deal: OpportunityView } | undefined)?.deal ?? null);
    }, []);

    const onDragEnd = useCallback(
        (event: DragEndEvent) => {
            const deal = (event.active.data.current as { deal: OpportunityView } | undefined)?.deal;
            setActive(null);
            if (!deal || !event.over) return;
            const stageId = String(event.over.id);
            if (stageId !== deal.stageId) onMove(deal, stageId);
        },
        [onMove],
    );

    const onCardKey = useCallback(
        (event: KeyboardEvent, deal: OpportunityView, laneIndex: number) => {
            if (!canMove) return;
            if (event.key === ' ' || event.key === 'Spacebar') {
                event.preventDefault();
                if (!picked || picked.deal.id !== deal.id) {
                    setPicked({ deal, fromLane: laneIndex, targetLane: laneIndex });
                    announce(
                        `${deal.name} picked up from ${stageNames[laneIndex]}. Use the left and right arrow keys to choose a stage, Space to drop, Escape to cancel.`,
                    );
                    return;
                }
                const target = columns[picked.targetLane];
                setPicked(null);
                if (!target || picked.targetLane === picked.fromLane) {
                    announce(`${deal.name} put back in ${stageNames[picked.fromLane]}.`);
                    return;
                }
                onMove(deal, target.stage.id);
                return;
            }
            if (!picked || picked.deal.id !== deal.id) return;
            if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                event.preventDefault();
                const targetLane = laneAfterKey(picked.targetLane, event.key, columns.length);
                setPicked({ ...picked, targetLane });
                const column = columns[targetLane];
                const position = targetLane === picked.fromLane ? column?.deals.findIndex((d) => d.id === deal.id) : 0;
                announce(
                    `${deal.name}, ${stageNames[targetLane]}, position ${(position ?? 0) + 1} of ${(column?.count ?? 0) + (targetLane === picked.fromLane ? 0 : 1)}.`,
                );
                return;
            }
            if (event.key === 'Escape') {
                event.preventDefault();
                setPicked(null);
                announce(`${deal.name} put back in ${stageNames[picked.fromLane]}.`);
            }
        },
        [announce, canMove, columns, onMove, picked, stageNames],
    );

    if (columns.length === 0) {
        return (
            <EmptyState
                title="This pipeline has no stages"
                body="Add stages in the pipeline settings before deals can be placed."
            />
        );
    }

    return (
        <DndContext
            sensors={sensors}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
            onDragCancel={() => setActive(null)}
        >
            <KanbanBoard>
                {columns.map((column, laneIndex) => (
                    <Lane
                        key={column.stage.id}
                        column={column}
                        laneIndex={laneIndex}
                        canMove={canMove}
                        membersById={membersById}
                        picked={picked}
                        onCardKey={onCardKey}
                        onShowList={onShowList}
                    />
                ))}
            </KanbanBoard>
            <DragOverlay dropAnimation={null}>
                {active && (
                    <CardBody
                        deal={active}
                        stage={stageOf(board, active.stageId)}
                        ownerName={ownerName(active, membersById)}
                    />
                )}
            </DragOverlay>
        </DndContext>
    );
}

interface LaneProps {
    column: BoardColumn;
    laneIndex: number;
    canMove: boolean;
    membersById: ReadonlyMap<string, string>;
    picked: Picked | null;
    onCardKey: (event: KeyboardEvent, deal: OpportunityView, laneIndex: number) => void;
    onShowList: () => void;
}

function Lane({ column, laneIndex, canMove, membersById, picked, onCardKey, onShowList }: LaneProps) {
    const { setNodeRef, isOver } = useDroppable({ id: column.stage.id, disabled: !canMove });
    const isKeyboardTarget = picked !== null && picked.targetLane === laneIndex && picked.fromLane !== laneIndex;
    const hidden = Math.max(column.count - column.deals.length, 0);
    const scrollRef = useRef<HTMLDivElement>(null);
    const virtual = column.deals.length > LANE_FOLD;
    const virtualizer = useVirtualizer({
        count: virtual ? column.deals.length : 0,
        getScrollElement: () => scrollRef.current,
        estimateSize: () => CARD_ESTIMATE_PX,
        overscan: VIRTUAL_OVERSCAN,
        gap: 12,
    });

    const card = (deal: OpportunityView) => (
        <DraggableCard
            key={deal.id}
            deal={deal}
            stage={column.stage}
            ownerName={ownerName(deal, membersById)}
            canMove={canMove}
            picked={picked?.deal.id === deal.id}
            onKeyDown={(event) => onCardKey(event, deal, laneIndex)}
        />
    );

    return (
        <KanbanLane
            ref={setNodeRef}
            name={column.stage.name}
            tone={STAGE_TONES[column.stage.colour]}
            count={column.count}
            sum={formatSums(column.amountMinorByCurrency)}
            menu={
                <Button
                    variant="ghost"
                    size="icon"
                    shape="square"
                    aria-label={`Options for ${column.stage.name}`}
                    disabled
                >
                    <MoreHorizontal aria-hidden />
                </Button>
            }
            className={cn(
                'rounded-lg transition-shadow',
                (isOver || isKeyboardTarget) && 'ring-2 ring-accent ring-offset-2 ring-offset-surface',
            )}
            data-drop-target={isOver || isKeyboardTarget ? 'true' : undefined}
        >
            {column.deals.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-xs text-text-faint">
                    No deals here
                </div>
            ) : (
                <div ref={scrollRef} className="-m-1 max-h-[calc(100vh-18rem)] overflow-y-auto p-1">
                    {virtual ? (
                        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
                            {virtualizer.getVirtualItems().map((item) => {
                                const deal = column.deals[item.index];
                                return deal ? (
                                    <div
                                        key={deal.id}
                                        ref={virtualizer.measureElement}
                                        data-index={item.index}
                                        style={{
                                            position: 'absolute',
                                            top: 0,
                                            left: 0,
                                            width: '100%',
                                            transform: `translateY(${item.start}px)`,
                                        }}
                                    >
                                        {card(deal)}
                                    </div>
                                ) : null;
                            })}
                        </div>
                    ) : (
                        <div className="flex flex-col gap-3">{column.deals.map(card)}</div>
                    )}
                </div>
            )}
            {hidden > 0 && (
                <button
                    type="button"
                    onClick={onShowList}
                    className="rounded-lg border-[1.5px] border-dashed border-border-strong px-4 py-3.5 text-center text-text-faint hover:text-text"
                >
                    {hidden} more — see the list
                </button>
            )}
        </KanbanLane>
    );
}

interface DraggableCardProps {
    deal: OpportunityView;
    stage: StageView | undefined;
    ownerName: string | undefined;
    canMove: boolean;
    picked: boolean;
    onKeyDown: (event: KeyboardEvent) => void;
}

function DraggableCard({ deal, stage, ownerName, canMove, picked, onKeyDown }: DraggableCardProps) {
    const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
        id: deal.id,
        data: { deal },
        disabled: !canMove,
    });
    const { role: _role, tabIndex: _tabIndex, ...rest } = attributes;
    return (
        // Opening a deal (click / Enter) arrives with the record pages (P1-UI-3), which own the deal route.
        <div
            ref={setNodeRef}
            {...rest}
            {...listeners}
            role="button"
            tabIndex={0}
            aria-label={`${deal.name}, ${stage?.name ?? 'stage'}${canMove ? '. Press Space to pick it up.' : ''}`}
            aria-roledescription={canMove ? 'draggable deal' : 'deal'}
            data-deal-id={deal.id}
            data-picked={picked ? 'true' : undefined}
            onKeyDown={onKeyDown}
            className={cn(
                'rounded-lg outline-none',
                canMove && 'cursor-grab active:cursor-grabbing',
                isDragging && 'opacity-40',
            )}
        >
            <CardBody deal={deal} stage={stage} ownerName={ownerName} highlighted={picked} />
        </div>
    );
}

function CardBody({
    deal,
    stage,
    ownerName,
    highlighted = false,
}: {
    deal: OpportunityView;
    stage: StageView | undefined;
    ownerName: string | undefined;
    highlighted?: boolean;
}) {
    const quiet =
        stage?.daysThreshold !== null && stage?.daysThreshold !== undefined && deal.daysInStage > stage.daysThreshold;
    const priority = deal.closedAt
        ? stage?.kind === 'won'
            ? { label: '✓ Won', status: 'success' as const }
            : stage?.kind === 'lost'
              ? { label: '✕ Lost', status: 'danger' as const }
              : undefined
        : quiet
          ? { label: '⚠ Quiet', status: 'warning' as const }
          : undefined;
    return (
        <DealCard
            reference={shortReference(deal.id)}
            {...(priority ? { priority } : {})}
            title={deal.name}
            chips={
                <>
                    {deal.closeDate && (
                        <CardChip>
                            <Clock aria-hidden /> Close {formatDate(deal.closeDate)}
                        </CardChip>
                    )}
                    {quiet && (
                        <CardChip className="text-warning">{daysLabel(deal.daysInStage)} · past threshold</CardChip>
                    )}
                </>
            }
            amount={formatMoney(deal.amount)}
            {...(ownerName ? { owner: { name: ownerName } } : {})}
            age={deal.closedAt ? formatDate(deal.closedAt) : `${daysLabel(deal.daysInStage)} in stage`}
            highlighted={highlighted}
            className={cn(highlighted && 'border-accent')}
        />
    );
}

function stageOf(board: BoardView, stageId: string): StageView | undefined {
    return board.pipeline.stages.find((s) => s.id === stageId);
}

function ownerName(deal: OpportunityView, membersById: ReadonlyMap<string, string>): string | undefined {
    return deal.ownerId ? membersById.get(deal.ownerId) : undefined;
}

/** A readable handle for a card: the id's tail, never its prefix (a UUIDv7 prefix is a timestamp). */
export function shortReference(id: string): string {
    return `BC-${id.replace(/-/g, '').slice(-6).toUpperCase()}`;
}

function formatDate(iso: string): string {
    return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(iso));
}

/** Exported for the list's "Won"/"Lost" badges: the same meaning, the same tone. */
export function closedBadge(deal: OpportunityView, stage: StageView | undefined) {
    if (!deal.closedAt) return null;
    return stage?.kind === 'won' ? <Badge status="success">Won</Badge> : <Badge status="danger">Lost</Badge>;
}

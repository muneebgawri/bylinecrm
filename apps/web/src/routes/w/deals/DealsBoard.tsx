import {
    DndContext,
    DragOverlay,
    PointerSensor,
    pointerWithin,
    rectIntersection,
    useDraggable,
    useDroppable,
    useSensor,
    useSensors,
    type CollisionDetection,
    type DragEndEvent,
    type DragStartEvent,
} from '@dnd-kit/core';
import { Button, CardChip, cn, DealCard, EmptyState, KanbanBoard, KanbanLane, toneSolid } from '@bylinecrm/ui';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowRightLeft, Clock, MoreHorizontal } from 'lucide-react';
import { useCallback, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { BoardColumn, BoardView, OpportunityView, StageView } from '../../../api/types';
import { formatDay } from '../../../lib/format';
import { formatMoneyCompact, formatSums } from '../../../lib/money';
import { CARD_ESTIMATE_PX, daysLabel, LANE_FOLD, STAGE_TONES, VIRTUAL_OVERSCAN } from './dealsView';
import { laneAfterKey } from './moveGate';

export interface DealsBoardProps {
    board: BoardView;
    /** `deal:move` — without it cards are read-only: no drag, no keyboard pick-up, no Move button. */
    canMove: boolean;
    /**
     * `lanes` (tablet and desktop): every stage side by side. `pages` (a phone, FR-CRMS-UI-12): one
     * stage per screen, swiped with scroll-snap, a chip row of stages on top.
     */
    layout: 'lanes' | 'pages';
    /** A finger is the pointer: no drag-and-drop; each card offers "Move to stage" instead. */
    touch: boolean;
    onMove: (deal: OpportunityView, stageId: string) => void;
    /** Opens the "Move to stage" sheet for a card (touch). */
    onMoveSheet: (deal: OpportunityView) => void;
    /** Opens the deal's record drawer (click, tap, Enter). */
    onOpen: (deal: OpportunityView) => void;
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
 * The lane under the pointer is the drop target — not the lane the dragged card's rectangle
 * overlaps most, which dnd-kit's default picks and which put a card one lane to the right of where
 * it was released when grabbed by its right edge (found in the browser walk). Off every lane, the
 * overlap decides.
 */
const dropUnderPointer: CollisionDetection = (args) => {
    const underPointer = pointerWithin(args);
    return underPointer.length > 0 ? underPointer : rectIntersection(args);
};

/**
 * The board: lanes from the API's columns. On a pointer device, drag between lanes with dnd-kit;
 * on touch, a "Move to stage" sheet per card. Everywhere, a keyboard twin that needs no pointer —
 * Space picks up, ←/→ choose a lane, Space drops, Escape cancels — announced (doc 50 §B), and a
 * click, tap or Enter opens the deal's drawer. Counts and sums are the API's for the current filter.
 */
export function DealsBoard({
    board,
    canMove,
    layout,
    touch,
    onMove,
    onMoveSheet,
    onOpen,
    announce,
    onShowList,
}: DealsBoardProps) {
    const [active, setActive] = useState<OpportunityView | null>(null);
    const [picked, setPicked] = useState<Picked | null>(null);
    const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: DRAG_DISTANCE_PX } }));
    const columns = board.columns;
    const stageNames = useMemo(() => columns.map((c) => c.stage.name), [columns]);
    const canDrag = canMove && !touch;

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
            if (event.key === 'Enter') {
                event.preventDefault();
                onOpen(deal);
                return;
            }
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
        [announce, canMove, columns, onMove, onOpen, picked, stageNames],
    );

    if (columns.length === 0) {
        return (
            <EmptyState
                title="This pipeline has no stages"
                body="Add stages in the pipeline settings before deals can be placed."
            />
        );
    }

    const lane = (column: BoardColumn, laneIndex: number, className?: string) => (
        <Lane
            key={column.stage.id}
            column={column}
            laneIndex={laneIndex}
            canDrag={canDrag}
            canMove={canMove}
            showMove={canMove && touch}
            picked={picked}
            onCardKey={onCardKey}
            onOpen={onOpen}
            onMoveSheet={onMoveSheet}
            onShowList={onShowList}
            ownScroll={layout === 'lanes'}
            {...(className ? { className } : {})}
        />
    );

    if (layout === 'pages') return <PagedBoard columns={columns} renderLane={lane} />;

    return (
        <DndContext
            sensors={sensors}
            collisionDetection={dropUnderPointer}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
            onDragCancel={() => setActive(null)}
        >
            <KanbanBoard>{columns.map((column, laneIndex) => lane(column, laneIndex))}</KanbanBoard>
            <DragOverlay dropAnimation={null}>
                {active && (
                    <CardBody
                        deal={active}
                        stage={board.pipeline.stages.find((s) => s.id === active.stageId)}
                        ownerName={ownerName(active)}
                    />
                )}
            </DragOverlay>
        </DndContext>
    );
}

/**
 * A phone's board (FR-CRMS-UI-12): one stage per screen in a horizontal scroll-snap strip, and a
 * row of stage chips that says where you are and jumps there. Swiping and the chips are the same
 * position: the chip follows the scroll, the scroll follows the chip.
 */
function PagedBoard({
    columns,
    renderLane,
}: {
    columns: readonly BoardColumn[];
    renderLane: (column: BoardColumn, laneIndex: number, className?: string) => ReactNode;
}) {
    const stripRef = useRef<HTMLDivElement>(null);
    const [current, setCurrent] = useState(0);

    const goTo = (index: number) => {
        const strip = stripRef.current;
        if (!strip) return;
        const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        strip.scrollTo({ left: index * strip.clientWidth, behavior: smooth ? 'smooth' : 'auto' });
        setCurrent(index);
    };

    return (
        <div>
            <nav aria-label="Stages" className="relative -mx-4 mb-3 flex gap-2 overflow-x-auto px-4 pb-1">
                {columns.map((column, index) => (
                    <button
                        key={column.stage.id}
                        type="button"
                        onClick={() => goTo(index)}
                        aria-current={index === current ? 'true' : undefined}
                        className={cn(
                            'inline-flex min-h-touch shrink-0 items-center gap-2 rounded-full border border-border bg-surface px-4 text-sm',
                            index === current && 'border-border-strong bg-surface-raised font-medium shadow-sm',
                        )}
                    >
                        <span
                            aria-hidden
                            className={cn('size-2 rounded-full', toneSolid[STAGE_TONES[column.stage.colour]])}
                        />
                        {column.stage.name}
                        <span className="text-text-faint tabular-nums">{column.count}</span>
                    </button>
                ))}
            </nav>
            <div
                ref={stripRef}
                role="region"
                aria-label="Pipeline board, one stage per screen"
                tabIndex={0}
                onScroll={(event) => {
                    const strip = event.currentTarget;
                    const index = Math.round(strip.scrollLeft / Math.max(strip.clientWidth, 1));
                    if (index !== current) setCurrent(index);
                }}
                // `relative`: an absolutely positioned descendant (the sr-only text of "Move to stage")
                // otherwise takes the page as its containing block, escapes this strip's clipping and
                // widens the page (found at 375px in the browser walk).
                className="relative flex snap-x snap-mandatory overflow-x-auto overscroll-x-contain"
            >
                {columns.map((column, index) => renderLane(column, index, 'w-full shrink-0 snap-start px-0.5'))}
            </div>
        </div>
    );
}

interface LaneProps {
    column: BoardColumn;
    laneIndex: number;
    canDrag: boolean;
    canMove: boolean;
    showMove: boolean;
    picked: Picked | null;
    onCardKey: (event: KeyboardEvent, deal: OpportunityView, laneIndex: number) => void;
    onOpen: (deal: OpportunityView) => void;
    onMoveSheet: (deal: OpportunityView) => void;
    onShowList: () => void;
    /**
     * Lanes side by side each scroll on their own (and virtualise past `LANE_FOLD`). On a phone the
     * page is the only vertical scroller — a scroller inside a scroller traps the finger — so a lane
     * grows with its cards; a column carries at most `BOARD_STAGE_LIMIT`, which bounds it.
     */
    ownScroll: boolean;
    className?: string;
}

function Lane({
    column,
    laneIndex,
    canDrag,
    canMove,
    showMove,
    picked,
    onCardKey,
    onOpen,
    onMoveSheet,
    onShowList,
    ownScroll,
    className,
}: LaneProps) {
    const { setNodeRef, isOver } = useDroppable({ id: column.stage.id, disabled: !canDrag });
    const isKeyboardTarget = picked !== null && picked.targetLane === laneIndex && picked.fromLane !== laneIndex;
    const hidden = Math.max(column.count - column.deals.length, 0);
    const scrollRef = useRef<HTMLDivElement>(null);
    const virtual = ownScroll && column.deals.length > LANE_FOLD;
    const virtualizer = useVirtualizer({
        count: virtual ? column.deals.length : 0,
        getScrollElement: () => scrollRef.current,
        estimateSize: () => CARD_ESTIMATE_PX,
        overscan: VIRTUAL_OVERSCAN,
        gap: 12,
    });

    const card = (deal: OpportunityView) => (
        <div key={deal.id} className="flex flex-col gap-1.5">
            <DraggableCard
                deal={deal}
                stage={column.stage}
                ownerName={ownerName(deal)}
                canDrag={canDrag}
                canMove={canMove}
                picked={picked?.deal.id === deal.id}
                onOpen={() => onOpen(deal)}
                onKeyDown={(event) => onCardKey(event, deal, laneIndex)}
            />
            {showMove && (
                <Button variant="ghost" size="sm" shape="square" className="self-end" onClick={() => onMoveSheet(deal)}>
                    <ArrowRightLeft aria-hidden /> Move to stage
                    <span className="sr-only">: {deal.name}</span>
                </Button>
            )}
        </div>
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
                className,
            )}
            data-drop-target={isOver || isKeyboardTarget ? 'true' : undefined}
        >
            {column.deals.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-xs text-text-faint">
                    No deals here
                </div>
            ) : (
                <div
                    ref={scrollRef}
                    // The negative margin lets an own scroller show its cards' focus rings; without one there is
                    // nothing to compensate for, and it would poke out of the phone's strip.
                    className={ownScroll ? '-m-1 max-h-[calc(100dvh-18rem)] overflow-y-auto p-1' : 'p-1'}
                >
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
                    className="min-h-touch rounded-lg border-[1.5px] border-dashed border-border-strong px-4 py-3.5 text-center text-text-faint hover:text-text"
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
    canDrag: boolean;
    /** `deal:move`: the keyboard pick-up works whether or not the pointer can drag. */
    canMove: boolean;
    picked: boolean;
    onOpen: () => void;
    onKeyDown: (event: KeyboardEvent) => void;
}

function DraggableCard({ deal, stage, ownerName, canDrag, canMove, picked, onOpen, onKeyDown }: DraggableCardProps) {
    const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
        id: deal.id,
        data: { deal },
        disabled: !canDrag,
    });
    const { role: _role, tabIndex: _tabIndex, ...rest } = attributes;
    const hintId = useId();
    return (
        // A press that travels less than DRAG_DISTANCE_PX is a click: it opens the deal's drawer, as Enter does.
        <div
            ref={setNodeRef}
            {...rest}
            {...listeners}
            role="button"
            tabIndex={0}
            // The card's visible text is its name (WCAG 2.5.3, label in name); the stage and the keys
            // are its description.
            aria-describedby={hintId}
            aria-roledescription={canDrag ? 'draggable deal' : 'deal'}
            data-deal-id={deal.id}
            data-picked={picked ? 'true' : undefined}
            onClick={onOpen}
            onKeyDown={onKeyDown}
            className={cn(
                'rounded-lg outline-none',
                canDrag ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer',
                isDragging && 'opacity-40',
            )}
        >
            <CardBody deal={deal} stage={stage} ownerName={ownerName} highlighted={picked} />
            <span id={hintId} className="sr-only">
                {`In ${stage?.name ?? 'this stage'}. Enter opens it${canMove ? '; Space picks it up to move' : ''}.`}
            </span>
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
                            <Clock aria-hidden /> Close {formatDay(deal.closeDate)}
                        </CardChip>
                    )}
                    {quiet && (
                        <CardChip className="text-warning">{daysLabel(deal.daysInStage)} · past threshold</CardChip>
                    )}
                </>
            }
            amount={formatMoneyCompact(deal.amount)}
            {...(ownerName ? { owner: { name: ownerName } } : {})}
            age={deal.closedAt ? formatDay(deal.closedAt) : `${daysLabel(deal.daysInStage)} in stage`}
            highlighted={highlighted}
            className={cn(highlighted && 'border-accent')}
        />
    );
}

/** The owner by the name the API embedded on the deal (P1-4a). */
function ownerName(deal: OpportunityView): string | undefined {
    return deal.owner ? (deal.owner.name ?? 'Member') : undefined;
}

/** A readable handle for a card: the id's tail, never its prefix (a UUIDv7 prefix is a timestamp). */
export function shortReference(id: string): string {
    return `BC-${id.replace(/-/g, '').slice(-6).toUpperCase()}`;
}

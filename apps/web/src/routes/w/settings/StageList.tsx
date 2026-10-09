import {
    closestCenter,
    DndContext,
    KeyboardSensor,
    PointerSensor,
    useSensor,
    useSensors,
    type DragEndEvent,
} from '@dnd-kit/core';
import {
    arrayMove,
    SortableContext,
    sortableKeyboardCoordinates,
    useSortable,
    verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Badge, Button, cn, DropdownMenuItem, Input, RowActionsMenu, type TableRowActions } from '@bylinecrm/ui';
import { GripVertical } from 'lucide-react';
import { useMemo, useState, type KeyboardEvent } from 'react';
import type { StageView } from '../../../api/types';
import { StageSwatch } from './StageEditor';
import { STAGE_KIND_LABEL, STAGE_REORDER_INSTRUCTIONS, stageReorderAnnouncements } from './settingsText';

/** How far a pointer travels before a press becomes a drag, so the handle still focuses on a click. */
const DRAG_DISTANCE_PX = 6;

export interface StageListProps {
    stages: readonly StageView[];
    /** `pipeline:configure`: without it the list reads only — no handle, no menu, no rename. */
    canConfigure: boolean;
    /** Every stage id, in the new order. */
    onReorder: (stageIds: string[]) => void;
    onRename: (stage: StageView, name: string) => void;
    onEdit: (stage: StageView) => void;
    onDelete: (stage: StageView) => void;
}

/**
 * A pipeline's stages in order (FR-CRMS-9). Reordered by dragging the handle, by its keyboard twin
 * (Space picks the stage up, the arrow keys move it, Space drops it, Escape cancels — announced by
 * name and position, never by id, FR-CRMS-UI-8), or by Move up / Move down in the row's menu, which
 * is the touch path on a phone. Renaming happens in place; everything else in the stage editor.
 */
export function StageList({ stages, canConfigure, onReorder, onRename, onEdit, onDelete }: StageListProps) {
    const ordered = useMemo(() => [...stages].sort((a, b) => a.position - b.position), [stages]);
    const ids = ordered.map((s) => s.id);
    const [renaming, setRenaming] = useState<string | null>(null);
    const sensors = useSensors(
        useSensor(PointerSensor, { activationConstraint: { distance: DRAG_DISTANCE_PX } }),
        useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
    );

    const move = (from: number, to: number) => {
        if (to < 0 || to >= ids.length || from === to) return;
        onReorder(arrayMove(ids, from, to));
    };
    const onDragEnd = ({ active, over }: DragEndEvent) => {
        if (!over || active.id === over.id) return;
        move(ids.indexOf(String(active.id)), ids.indexOf(String(over.id)));
    };

    const actions: TableRowActions<StageView> = {
        label: (stage) => stage.name,
        items: (stage) => {
            const index = ids.indexOf(stage.id);
            return (
                <>
                    <DropdownMenuItem onSelect={() => setRenaming(stage.id)}>Rename</DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => onEdit(stage)}>Edit</DropdownMenuItem>
                    <DropdownMenuItem disabled={index === 0} onSelect={() => move(index, index - 1)}>
                        Move up
                    </DropdownMenuItem>
                    <DropdownMenuItem disabled={index === ids.length - 1} onSelect={() => move(index, index + 1)}>
                        Move down
                    </DropdownMenuItem>
                    <DropdownMenuItem destructive onSelect={() => onDelete(stage)}>
                        Delete
                    </DropdownMenuItem>
                </>
            );
        },
    };

    const list = (
        <ol aria-label="Stages" className="m-0 grid list-none gap-0 p-0">
            {ordered.map((stage, index) => (
                <StageRow
                    key={stage.id}
                    stage={stage}
                    index={index}
                    total={ordered.length}
                    canConfigure={canConfigure}
                    renaming={renaming === stage.id}
                    onRenameDone={(name) => {
                        setRenaming(null);
                        if (name !== null && name.trim() && name.trim() !== stage.name) onRename(stage, name.trim());
                    }}
                    actions={canConfigure ? actions : undefined}
                />
            ))}
        </ol>
    );
    if (!canConfigure) return list;
    return (
        <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={onDragEnd}
            accessibility={{
                announcements: stageReorderAnnouncements(ordered),
                screenReaderInstructions: { draggable: STAGE_REORDER_INSTRUCTIONS },
            }}
        >
            <SortableContext items={ids} strategy={verticalListSortingStrategy}>
                {list}
            </SortableContext>
        </DndContext>
    );
}

function StageRow({
    stage,
    index,
    total,
    canConfigure,
    renaming,
    onRenameDone,
    actions,
}: {
    stage: StageView;
    index: number;
    total: number;
    canConfigure: boolean;
    renaming: boolean;
    /** The new name, or `null` when the rename was cancelled. */
    onRenameDone: (name: string | null) => void;
    actions: TableRowActions<StageView> | undefined;
}) {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
        id: stage.id,
        disabled: !canConfigure,
    });
    const style = { transform: CSS.Transform.toString(transform), transition };
    return (
        <li
            ref={setNodeRef}
            style={style}
            className={cn(
                'flex items-center gap-3 border-b border-border bg-surface px-3 py-2 last:border-b-0 max-md:min-h-touch',
                isDragging && 'relative z-10 shadow-md',
            )}
        >
            {canConfigure && (
                <Button
                    variant="ghost"
                    size="icon"
                    shape="square"
                    className="cursor-grab touch-none active:cursor-grabbing max-md:hidden"
                    aria-label={`Reorder ${stage.name}, position ${index + 1} of ${total}`}
                    {...attributes}
                    {...listeners}
                >
                    <GripVertical aria-hidden />
                </Button>
            )}
            <StageSwatch colour={stage.colour} />
            <div className="grid min-w-0 flex-1 gap-0.5">
                {renaming ? (
                    <RenameInput name={stage.name} onDone={onRenameDone} />
                ) : (
                    <span className="flex items-center gap-2">
                        <span data-testid="stage-name" className="truncate font-medium">
                            {stage.name}
                        </span>
                        {stage.kind !== 'open' && (
                            <Badge status={stage.kind === 'won' ? 'success' : 'danger'} shape="pill">
                                {STAGE_KIND_LABEL[stage.kind]}
                            </Badge>
                        )}
                    </span>
                )}
                <span className="text-xs text-text-muted">
                    {stage.probability}% win probability
                    {stage.daysThreshold !== null && ` · flagged after ${stage.daysThreshold} days`}
                </span>
            </div>
            {actions && <RowActionsMenu actions={actions} row={stage} />}
        </li>
    );
}

/** Rename in place: Enter or leaving the field saves, Escape puts the old name back. */
function RenameInput({ name, onDone }: { name: string; onDone: (name: string | null) => void }) {
    const [value, setValue] = useState(name);
    const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            onDone(value);
        } else if (event.key === 'Escape') {
            event.preventDefault();
            onDone(null);
        }
    };
    return (
        <Input
            aria-label={`Rename ${name}`}
            value={value}
            maxLength={120}
            autoFocus
            className="h-8 max-md:h-touch"
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={onKeyDown}
            onBlur={() => onDone(value)}
        />
    );
}

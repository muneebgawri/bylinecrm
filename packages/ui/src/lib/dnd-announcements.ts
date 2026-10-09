/**
 * Screen-reader announcements for drag and drop, built from the names people see — never from the
 * ids a drag library works with (FR-CRMS-UI-8).
 *
 * dnd-kit speaks through a live region of its own, and that region is `aria-live="assertive"`
 * with no option to change it. A page that also has its own polite region (the deals board does,
 * for its keyboard twin and the server's answer) then talks over itself, and dnd-kit's defaults
 * read ids aloud ("Draggable item db80f38f-… was dropped over droppable area 24400e15-…"). So
 * every callback here sends its text to the page's ONE polite region through `announce`, and
 * returns `undefined` to dnd-kit, whose assertive region therefore never speaks.
 *
 * The shapes below are dnd-kit's `Announcements` structurally (this package does not depend on
 * dnd-kit); a caller passes the result as `accessibility.announcements` on `DndContext`, where
 * TypeScript checks the fit.
 */

/** A draggable's or a drop area's id, as dnd-kit hands it over. */
export type DndId = string | number;

interface DndActive {
    id: DndId;
}
interface DndOver {
    id: DndId;
}

/** dnd-kit's `Announcements`, structurally. Every callback returns nothing to dnd-kit. */
export interface DndAnnouncements {
    onDragStart(event: { active: DndActive }): undefined;
    onDragMove?(event: { active: DndActive; over: DndOver | null }): undefined;
    onDragOver(event: { active: DndActive; over: DndOver | null }): undefined;
    onDragEnd(event: { active: DndActive; over: DndOver | null }): undefined;
    onDragCancel(event: { active: DndActive; over: DndOver | null }): undefined;
}

export interface DndAnnouncementNames {
    /** The name of the thing being dragged ("Series B PR"). */
    itemName(id: DndId): string;
    /** The name of the place it is over ("Contacted"). */
    containerName(id: DndId): string;
    /** Where it would land in that place, when the caller knows: 0-based index of `total`. */
    position?: ((activeId: DndId, overId: DndId) => { index: number; total: number } | undefined) | undefined;
    /** The page's one polite live region. */
    announce(text: string): void;
    /**
     * Whether to say "dropped in X" on a drop over a place. Off when the caller speaks the outcome
     * itself (the board's move hook says "moving to …", then "moved to …" or why it was refused),
     * so the two do not talk over each other. A drop over nothing is always announced.
     */
    announceDrop?: boolean;
    /** The place the item came from: a drop there is "put back in X", whatever `announceDrop` says. */
    isHome?: ((activeId: DndId, overId: DndId) => boolean) | undefined;
}

/**
 * The instructions dnd-kit attaches to a draggable for screen readers. The default names the
 * space bar and describes dnd-kit's own keyboard sensor; a page that drives the keyboard itself
 * (the deals board's Space / arrows / Space twin) replaces it with this.
 */
export const DND_INSTRUCTIONS = {
    draggable:
        'To move this item, press Space to pick it up, use the arrow keys to choose where it goes, and press Space again to drop it. Press Escape to cancel.',
} as const;

export function makeDndAnnouncements({
    itemName,
    containerName,
    position,
    announce,
    announceDrop = true,
    isHome,
}: DndAnnouncementNames): DndAnnouncements {
    /** The last place announced, so hovering over one place speaks once, not on every pointer move. */
    let lastOver: DndId | null = null;

    const where = (activeId: DndId, overId: DndId) => {
        const at = position?.(activeId, overId);
        return at ? `${containerName(overId)}, position ${at.index + 1} of ${at.total}` : containerName(overId);
    };

    const over = ({ active, over: target }: { active: DndActive; over: DndOver | null }): undefined => {
        const next = target?.id ?? null;
        if (next === lastOver) return undefined;
        lastOver = next;
        announce(
            target
                ? `${itemName(active.id)} over ${where(active.id, target.id)}.`
                : `${itemName(active.id)} is no longer over a drop area.`,
        );
        return undefined;
    };

    return {
        onDragStart({ active }) {
            lastOver = null;
            announce(`${itemName(active.id)} picked up.`);
            return undefined;
        },
        onDragOver: over,
        onDragMove() {
            // The pointer's every move is not news; `onDragOver` speaks when the place changes.
            return undefined;
        },
        onDragEnd({ active, over: target }) {
            lastOver = null;
            if (!target) announce(`${itemName(active.id)} put back.`);
            else if (isHome?.(active.id, target.id))
                announce(`${itemName(active.id)} put back in ${containerName(target.id)}.`);
            else if (announceDrop) announce(`${itemName(active.id)} dropped in ${containerName(target.id)}.`);
            return undefined;
        },
        onDragCancel({ active }) {
            lastOver = null;
            announce(`${itemName(active.id)} put back.`);
            return undefined;
        },
    };
}

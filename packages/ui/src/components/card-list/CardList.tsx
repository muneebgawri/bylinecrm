import { Check } from 'lucide-react';
import { useEffect, useRef, type PointerEvent, type ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { focusRing } from '../../lib/focus';

/** How long a press must last to start choosing several cards. */
export const LONG_PRESS_MS = 500;

/** One record as a phone card: what to show, in the slots every card has. */
export interface CardListItem {
    id: string;
    /** An avatar or icon at the start of the card. Replaced by the check mark while choosing. */
    leading?: ReactNode;
    /** The record's name — the line a reader scans. */
    primary: ReactNode;
    /** One muted line under the name: company, role, prefix… joined with a separator. */
    secondary?: readonly ReactNode[];
    /** Stacked at the card's end: a status, when it last changed. */
    meta?: readonly ReactNode[];
    /** The row's actions (one "•••" menu), beside the card's body so it never nests in its button. */
    actions?: ReactNode;
}

export interface CardListProps {
    items: readonly CardListItem[];
    /** Names the list for assistive technology ("People", "Members"). */
    'aria-label': string;
    /** A tap opens the record. Without it (and outside select mode) a card is not a button. */
    onOpen?: (id: string) => void;
    /** In select mode a tap chooses a card instead of opening it. */
    selecting?: boolean;
    selected?: ReadonlySet<string>;
    onToggle?: (id: string) => void;
    /** A long press on a touch screen starts select mode with that card chosen. */
    onStartSelecting?: (id: string) => void;
    /** Load the next page when the end of the list scrolls into view. */
    hasMore?: boolean;
    loadingMore?: boolean;
    onMore?: () => void;
    className?: string;
}

const EMPTY: ReadonlySet<string> = new Set();

/**
 * The phone list (doc 48 FR-CRMS-UI-12): one stacked card per record, a whole-card target well over
 * 44px, the next page loaded as the end scrolls into view, and a long press that turns taps into
 * choosing. Every list in the product renders this on a phone — the record lists directly, and
 * every `DataTableChrome` table through its columns' phone roles — so there is one card, not one
 * per page.
 */
export function CardList({
    items,
    'aria-label': label,
    onOpen,
    selecting = false,
    selected = EMPTY,
    onToggle,
    onStartSelecting,
    hasMore = false,
    loadingMore = false,
    onMore,
    className,
}: CardListProps) {
    const sentinel = useRef<HTMLLIElement>(null);
    const press = useRef<{ timer: ReturnType<typeof setTimeout>; fired: boolean } | null>(null);

    useEffect(() => {
        const node = sentinel.current;
        if (!node || !hasMore || !onMore) return;
        const observer = new IntersectionObserver((entries) => {
            if (entries.some((e) => e.isIntersecting) && !loadingMore) onMore();
        });
        observer.observe(node);
        return () => observer.disconnect();
    }, [hasMore, loadingMore, onMore]);

    const startPress = (id: string) => (e: PointerEvent) => {
        if (selecting || !onStartSelecting || e.pointerType === 'mouse') return;
        const timer = setTimeout(() => {
            if (press.current) press.current.fired = true;
            onStartSelecting(id);
        }, LONG_PRESS_MS);
        press.current = { timer, fired: false };
    };
    const endPress = () => {
        if (press.current) clearTimeout(press.current.timer);
    };

    return (
        <ul aria-label={label} className={cn('m-0 flex list-none flex-col gap-2 p-0', className)}>
            {items.map((item) => {
                const chosen = selected.has(item.id);
                const interactive = selecting || Boolean(onOpen);
                const body = (
                    <>
                        {selecting ? (
                            <span
                                aria-hidden
                                className={cn(
                                    'grid size-6 shrink-0 place-items-center rounded-full border border-border-strong',
                                    chosen && 'border-accent bg-accent text-accent-foreground',
                                )}
                            >
                                {chosen && <Check className="size-4" />}
                            </span>
                        ) : (
                            item.leading
                        )}
                        <span className="min-w-0 flex-1">
                            <span className="block truncate font-medium">{item.primary}</span>
                            {item.secondary && item.secondary.length > 0 && (
                                /*
                                 * Separators never lead a line (#82): each part draws its "·" as a
                                 * pseudo-element in the space to its left, the row is shifted left by
                                 * that space, and the outer span clips it — so the first part of every
                                 * wrapped line has its dot cut off, and no dot is a text node.
                                 */
                                <span data-card-secondary className="block overflow-hidden text-[13px] text-text-muted">
                                    <span className="-ml-3 flex min-w-0 flex-wrap items-center gap-y-1">
                                        {item.secondary.map((part, i) => (
                                            <span
                                                key={i}
                                                className="relative min-w-0 truncate pl-3 before:absolute before:left-1 before:content-['·']"
                                            >
                                                {part}
                                            </span>
                                        ))}
                                    </span>
                                </span>
                            )}
                        </span>
                        {item.meta && item.meta.length > 0 && (
                            <span className="flex shrink-0 flex-col items-end gap-1 text-xs text-text-faint">
                                {item.meta.map((part, i) => (
                                    <span key={i}>{part}</span>
                                ))}
                            </span>
                        )}
                    </>
                );
                return (
                    <li
                        key={item.id}
                        className={cn(
                            'flex min-h-16 items-center gap-1 rounded-lg border border-border bg-surface shadow-sm',
                            chosen && 'border-accent bg-selection',
                        )}
                    >
                        {interactive ? (
                            <button
                                type="button"
                                role={selecting ? 'checkbox' : undefined}
                                aria-checked={selecting ? chosen : undefined}
                                onPointerDown={startPress(item.id)}
                                onPointerUp={endPress}
                                onPointerLeave={endPress}
                                onContextMenu={(e) => e.preventDefault()}
                                onClick={() => {
                                    if (press.current?.fired) {
                                        press.current = null;
                                        return;
                                    }
                                    if (selecting) onToggle?.(item.id);
                                    else onOpen?.(item.id);
                                }}
                                className={cn(
                                    'flex min-h-16 min-w-0 flex-1 items-center gap-3 rounded-lg p-3 text-left',
                                    focusRing,
                                )}
                            >
                                {body}
                            </button>
                        ) : (
                            <div className="flex min-w-0 flex-1 items-center gap-3 p-3">{body}</div>
                        )}
                        {item.actions && !selecting && <div className="shrink-0 pr-1">{item.actions}</div>}
                    </li>
                );
            })}
            {hasMore && (
                <li ref={sentinel} className="py-3 text-center text-[13px] text-text-muted">
                    {loadingMore ? 'Loading more…' : ' '}
                </li>
            )}
        </ul>
    );
}

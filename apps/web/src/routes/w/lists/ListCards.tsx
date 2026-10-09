import { Avatar, Badge, cn, focusRing } from '@bylinecrm/ui';
import { Check } from 'lucide-react';
import { useEffect, useRef, type PointerEvent } from 'react';
import { formatRelative } from '../../../lib/format';
import { identityName, identitySubline } from './ListTable';
import type { CellContext, ListObject, ListRow } from './listConfig';

/** How long a press must last to start choosing several cards. */
const LONG_PRESS_MS = 500;

export interface ListCardsProps<O extends ListObject> {
    object: O;
    rows: readonly ListRow<O>[];
    context: CellContext;
    /** In select mode a tap chooses a card; otherwise it opens the record. */
    selecting: boolean;
    selected: ReadonlySet<string>;
    onToggle: (id: string) => void;
    /** A long press starts select mode with that card chosen. */
    onStartSelecting: (id: string) => void;
    onOpen: (row: ListRow<O>) => void;
    hasMore: boolean;
    loadingMore: boolean;
    onMore: () => void;
}

/**
 * The phone list (FR-CRMS-UI-12): one stacked card per record — avatar, name, company or
 * domain, a status, when it last changed — a whole-card target well over 44px, and the next page
 * loaded as the end of the list scrolls into view. A long press (or the page's Select button)
 * turns taps into choosing.
 */
export function ListCards<O extends ListObject>(props: ListCardsProps<O>) {
    const { object, rows, context, selecting, selected, hasMore, loadingMore, onMore } = props;
    const sentinel = useRef<HTMLLIElement>(null);
    const press = useRef<{ timer: ReturnType<typeof setTimeout>; fired: boolean } | null>(null);

    useEffect(() => {
        const node = sentinel.current;
        if (!node || !hasMore) return;
        const observer = new IntersectionObserver((entries) => {
            if (entries.some((e) => e.isIntersecting) && !loadingMore) onMore();
        });
        observer.observe(node);
        return () => observer.disconnect();
    }, [hasMore, loadingMore, onMore]);

    const startPress = (id: string) => (e: PointerEvent) => {
        if (selecting || e.pointerType === 'mouse') return;
        const timer = setTimeout(() => {
            if (press.current) press.current.fired = true;
            props.onStartSelecting(id);
        }, LONG_PRESS_MS);
        press.current = { timer, fired: false };
    };
    const endPress = () => {
        if (press.current) clearTimeout(press.current.timer);
    };

    return (
        <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label={object === 'person' ? 'People' : 'Companies'}>
            {rows.map((row) => {
                const name = identityName(object, row);
                const chosen = selected.has(row.id);
                const secondary =
                    object === 'person'
                        ? (() => {
                              const companyId = (row as ListRow<'person'>).companyId;
                              return companyId
                                  ? (context.companies.get(companyId) ?? '…')
                                  : identitySubline(object, row);
                          })()
                        : identitySubline(object, row);
                return (
                    <li key={row.id}>
                        <button
                            type="button"
                            role={selecting ? 'checkbox' : undefined}
                            aria-checked={selecting ? chosen : undefined}
                            onPointerDown={startPress(row.id)}
                            onPointerUp={endPress}
                            onPointerLeave={endPress}
                            onContextMenu={(e) => e.preventDefault()}
                            onClick={() => {
                                if (press.current?.fired) {
                                    press.current = null;
                                    return;
                                }
                                if (selecting) props.onToggle(row.id);
                                else props.onOpen(row);
                            }}
                            className={cn(
                                'flex min-h-16 w-full items-center gap-3 rounded-lg border border-border bg-surface p-3 text-left shadow-sm',
                                chosen && 'border-accent bg-selection',
                                focusRing,
                            )}
                        >
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
                                <Avatar name={name} size="md" />
                            )}
                            <span className="min-w-0 flex-1">
                                <span className="block truncate font-medium">{name}</span>
                                {secondary && (
                                    <span className="block truncate text-[13px] text-text-muted">{secondary}</span>
                                )}
                            </span>
                            <span className="flex shrink-0 flex-col items-end gap-1">
                                <Status object={object} row={row} context={context} />
                                <span className="text-xs text-text-faint">{formatRelative(row.updatedAt)}</span>
                            </span>
                        </button>
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

/** The one status a card shows: who owns a person; whether a company is an ideal customer. */
function Status<O extends ListObject>({ object, row, context }: { object: O; row: ListRow<O>; context: CellContext }) {
    if (object === 'company') {
        return (row as ListRow<'company'>).icp ? <Badge status="success">Ideal customer</Badge> : null;
    }
    const ownerId = row.ownerId;
    if (!ownerId) return <Badge status="warning">No owner</Badge>;
    return <span className="max-w-28 truncate text-xs text-text-muted">{context.members.get(ownerId) ?? '…'}</span>;
}

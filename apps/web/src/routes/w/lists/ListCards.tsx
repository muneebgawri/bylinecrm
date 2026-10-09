import { Avatar, Badge, CardList, type CardListItem } from '@bylinecrm/ui';
import type { ReactNode } from 'react';
import { formatRelative } from '../../../lib/format';
import { identityName, identitySubline } from './ListTable';
import { ownerCell, type ListObject, type ListRow } from './listConfig';

export interface ListCardsProps<O extends ListObject> {
    object: O;
    rows: readonly ListRow<O>[];
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
 * The record list on a phone (FR-CRMS-UI-12): what a person or company card says — avatar, name,
 * company or domain, one status, when it last changed — drawn by the design system's `CardList`,
 * the same card every list in the product uses on a phone. Names come from the row (P1-4a).
 */
export function ListCards<O extends ListObject>(props: ListCardsProps<O>) {
    const { object, rows } = props;
    const byId = new Map(rows.map((row) => [row.id, row]));
    const items: CardListItem[] = rows.map((row) => {
        const name = identityName(object, row);
        const secondary =
            (object === 'person' ? (row as ListRow<'person'>).company?.name : undefined) ??
            identitySubline(object, row);
        return {
            id: row.id,
            leading: <Avatar name={name} size="md" />,
            primary: name,
            secondary: secondary ? [secondary] : [],
            meta: [status(object, row), formatRelative(row.updatedAt)].filter((part) => part !== null),
        };
    });
    return (
        <CardList
            aria-label={object === 'person' ? 'People' : 'Companies'}
            items={items}
            onOpen={(id) => {
                const row = byId.get(id);
                if (row) props.onOpen(row);
            }}
            selecting={props.selecting}
            selected={props.selected}
            onToggle={props.onToggle}
            onStartSelecting={props.onStartSelecting}
            hasMore={props.hasMore}
            loadingMore={props.loadingMore}
            onMore={props.onMore}
        />
    );
}

/**
 * The one status a card shows, or `null` for none — who owns a person; whether a company is an
 * ideal customer. A plain function, not a component, so "none" leaves no empty slot on the card.
 */
function status<O extends ListObject>(object: O, row: ListRow<O>): ReactNode {
    if (object === 'company') {
        return (row as ListRow<'company'>).icp ? <Badge status="success">Ideal customer</Badge> : null;
    }
    const owner = (row as ListRow<'person'>).owner;
    if (!owner) return ownerCell(owner);
    return <span className="max-w-28 truncate text-xs text-text-muted">{ownerCell(owner)}</span>;
}

import type { FieldChange } from '@bylinecrm/shared';

/**
 * The fields of `after` that differ from `before`, by name, for an `updated` event. Values are
 * compared structurally (JSON), which is what a record's columns and composites are.
 */
export function diffOf<T extends object>(
    before: T,
    after: T,
    fields: readonly (keyof T & string)[],
): Record<string, FieldChange> {
    const diff: Record<string, FieldChange> = {};
    for (const field of fields) {
        const from = before[field];
        const to = after[field];
        if (JSON.stringify(from) !== JSON.stringify(to)) diff[field] = { from, to };
    }
    return diff;
}

/**
 * What writing `data` over `current` would change, as the record's view shows it — computed
 * before the write (P1-4a). `data` is keyed by the row's columns, as Prisma takes it; the
 * projected row is `current` with `data` laid over it. An update whose projection changes none
 * of `fields` is not written and not announced: a no-op is no event.
 */
export function projectedChanges<Row extends object, View extends object>(
    current: Row,
    data: object,
    view: (row: Row) => View,
    fields: readonly (keyof View & string)[],
): Record<string, FieldChange> {
    return diffOf(view(current), view({ ...current, ...data } as Row), fields);
}

/** A diff with no changes in it. */
export function isEmpty(diff: Record<string, FieldChange>): boolean {
    return Object.keys(diff).length === 0;
}

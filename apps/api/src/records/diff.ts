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

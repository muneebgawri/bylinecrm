import { BadRequestException } from '@nestjs/common';
import { SORT_MAX_FIELDS, type ViewSort } from '@bylinecrm/shared';
import { fieldNamed, type ResolvedField } from './fields';

/** A Prisma `orderBy` list, untyped at the boundary like the compiled filter. */
export type CompiledOrderBy = Record<string, 'asc' | 'desc'>[];

/**
 * Parses `field:asc,field2:desc` — up to `SORT_MAX_FIELDS` — against the object's fields.
 * A field that is not there or not sortable is `400`; a custom field is never sortable in v1
 * (a JSON path has no index to order by), and the message says so.
 */
export function parseSorts(raw: string | undefined, fields: readonly ResolvedField[]): ViewSort[] {
    if (raw === undefined || raw === '') return [];
    const parts = raw.split(',');
    if (parts.length > SORT_MAX_FIELDS) throw new BadRequestException(`sort takes at most ${SORT_MAX_FIELDS} fields`);
    return parts.map((part) => {
        const [field, direction] = part.split(':');
        if (!field || (direction !== 'asc' && direction !== 'desc')) {
            throw new BadRequestException('sort is field:asc or field:desc, comma-separated');
        }
        checkSortable(fields, field);
        return { field, direction };
    });
}

/** Every sort of a saved view names a sortable field; the same check the query string gets. */
export function checkSortable(fields: readonly ResolvedField[], name: string): ResolvedField {
    const field = fieldNamed(fields, name, 'sort');
    if (!field.sortable) {
        throw new BadRequestException(
            field.storage === 'custom' ? `sort: custom fields cannot be sorted on` : `sort: ${name} is not sortable`,
        );
    }
    return field;
}

/** The sorts as Prisma orders by them, with `id` as the final tie-break so a cursor is stable. */
export function orderBy(
    sorts: readonly ViewSort[],
    fields: readonly ResolvedField[],
    fallback: ViewSort,
): CompiledOrderBy {
    const effective = sorts.length ? sorts : [fallback];
    return [
        ...effective.map((s) => {
            const field = checkSortable(fields, s.field);
            // Only a column is sortable (checked above), so the storage is known here.
            const column = field.storage === 'column' ? field.column : field.name;
            return { [column]: s.direction };
        }),
        { id: 'asc' as const },
    ];
}

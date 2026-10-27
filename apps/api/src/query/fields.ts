import { BadRequestException } from '@nestjs/common';
import {
    CUSTOM_FIELD_KIND,
    customFieldKey,
    customFieldName,
    type FieldDescriptor,
    ID_FIELD,
    type RecordObject,
    STANDARD_FIELDS,
} from '@bylinecrm/shared';
import type { FieldDefinition } from '../records/custom-fields/custom-values';

/**
 * A field the query machinery can act on: the shared descriptor, plus where it lives — a column
 * of the model (by its Prisma name), a path into one of its JSON columns, or a key of the record's
 * `custom` JSON. The one place the API's field names meet the database's.
 */
export type ResolvedField = FieldDescriptor &
    (
        | { storage: 'column'; column: string }
        | { storage: 'json'; column: string; path: readonly string[] }
        | { storage: 'custom'; key: string }
    );

/**
 * The column each standard field's API name maps to, where the two differ. Money fields are
 * stored as `<name>Minor` (one `Money` representation: minor units + currency); everything else
 * is named alike on both sides.
 */
const COLUMN_BY_NAME: Readonly<Record<RecordObject, Readonly<Record<string, string>>>> = {
    person: {},
    company: { arr: 'arrMinor' },
    opportunity: { amount: 'amountMinor' },
};

/** Standard fields read from inside a JSON column (a composite), by path; they filter and export, never sort. */
const JSON_PATH_BY_NAME: Readonly<Record<RecordObject, Readonly<Record<string, readonly [string, ...string[]]>>>> = {
    person: { phonePrimary: ['phones', 'primary', 'number'], phoneExtension: ['phones', 'primary', 'extension'] },
    company: {},
    opportunity: {},
};

/**
 * Every field of an object the caller may name: the standard ones, then the workspace's custom
 * ones, then `id` (filterable and exportable by name, never offered as a default column).
 */
export function resolveFields(object: RecordObject, definitions: readonly FieldDefinition[]): ResolvedField[] {
    const standard: ResolvedField[] = STANDARD_FIELDS[object].map((f) => {
        const json = JSON_PATH_BY_NAME[object][f.name];
        return json
            ? { ...f, storage: 'json', column: json[0], path: json.slice(1) }
            : { ...f, storage: 'column', column: COLUMN_BY_NAME[object][f.name] ?? f.name };
    });
    const id: ResolvedField = { ...ID_FIELD, storage: 'column', column: 'id' };
    const custom: ResolvedField[] = definitions.map((d) => ({
        name: customFieldName(d.key),
        label: d.label,
        kind: CUSTOM_FIELD_KIND[d.type],
        sortable: false,
        groupable: d.type === 'select' || d.type === 'boolean',
        options: d.type === 'select' || d.type === 'multiselect' ? d.options : undefined,
        storage: 'custom',
        key: d.key,
    }));
    return [...standard, ...custom, id];
}

/** The field a name refers to, or `400` naming it — a field that is not there cannot be filtered on. */
export function fieldNamed(fields: readonly ResolvedField[], name: string, what: string): ResolvedField {
    const field = fields.find((f) => f.name === name);
    if (!field) {
        const custom = customFieldKey(name);
        throw new BadRequestException(
            custom
                ? `${what}: custom field "${custom}" does not exist or is archived`
                : `${what}: unknown field "${name}"`,
        );
    }
    return field;
}

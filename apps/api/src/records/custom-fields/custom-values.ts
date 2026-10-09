import type { CustomFieldType } from '@bylinecrm/shared';
import { z } from 'zod';
import { ValidationFailed } from '../../infra/errors/api-errors';

/** What the validator needs to know about one field. */
export interface FieldDefinition {
    key: string;
    /** Shown as a column header and in the filter editor; the key is the value's name, the label the human's. */
    label: string;
    type: CustomFieldType;
    options: string[];
    required: boolean;
}

/** On `create` a required field must be present; on `patch` it may be absent but never cleared. */
export type ValidationMode = 'create' | 'patch';

/** Upper bound on a text value; the column is JSONB, so this is the only limit. */
const TEXT_MAX = 10_000;
/** Loose international format: an optional `+`, then digits with the usual separators. */
const PHONE = /^\+?[0-9 ()./-]{3,30}$/;

/**
 * Why a definition's options do not fit its type, or `null` when they do. One rule for the
 * create DTO, the update path and the validator — selects need at least one distinct option,
 * every other type has none.
 */
export function optionsProblem(type: CustomFieldType, options: readonly string[]): string | null {
    const isSelect = type === 'select' || type === 'multiselect';
    if (isSelect && options.length === 0) return `${type} needs at least one option`;
    if (isSelect && new Set(options).size !== options.length) return 'options must be distinct';
    if (!isSelect && options.length > 0) return `${type} takes no options`;
    return null;
}

function valueSchema(definition: FieldDefinition): z.ZodType {
    switch (definition.type) {
        case 'text':
            return z.string().max(TEXT_MAX);
        case 'number':
            return z.number().finite();
        case 'boolean':
            return z.boolean();
        case 'date':
            return z.iso.date();
        case 'datetime':
            return z.iso.datetime({ offset: true });
        case 'select':
            return z.enum(definition.options as [string, ...string[]]);
        case 'multiselect':
            return z.array(z.enum(definition.options as [string, ...string[]])).max(definition.options.length);
        case 'url':
            return z.url().max(2048);
        case 'email':
            return z.email().max(254);
        case 'phone':
            return z.string().regex(PHONE);
    }
}

/**
 * The schema a record's `custom` object must satisfy: exactly the active definitions' keys
 * (unknown keys are refused), each with its type, a required field present on create and
 * never `null`, an optional field nullable.
 */
export function customValuesSchema(definitions: readonly FieldDefinition[], mode: ValidationMode): z.ZodType {
    const shape: Record<string, z.ZodType> = {};
    for (const definition of definitions) {
        const value = valueSchema(definition);
        if (definition.required) shape[definition.key] = mode === 'create' ? value : value.optional();
        else shape[definition.key] = value.nullable().optional();
    }
    return z.strictObject(shape);
}

/** Validates `values`, or throws a `400` whose field errors are keyed `custom.<key>`. */
export function validateCustomValues(
    definitions: readonly FieldDefinition[],
    values: Record<string, unknown>,
    mode: ValidationMode,
): Record<string, unknown> {
    const result = customValuesSchema(definitions, mode).safeParse(values);
    if (result.success) return result.data as Record<string, unknown>;
    throw new ValidationFailed(
        'custom field values are invalid',
        result.error.issues.flatMap((issue) =>
            // An unknown key is reported once per key, under that key, like every other problem.
            issue.code === 'unrecognized_keys'
                ? issue.keys.map((key) => ({ path: `custom.${key}`, message: 'unknown custom field' }))
                : [{ path: ['custom', ...issue.path.map(String)].join('.'), message: issue.message }],
        ),
    );
}

/**
 * Applies a validated patch to the stored values: a key set to `null` is removed, anything else
 * replaces the stored value, keys not mentioned are kept.
 */
export function mergeCustomValues(
    stored: Record<string, unknown>,
    patch: Record<string, unknown>,
): Record<string, unknown> {
    const merged = { ...stored };
    for (const [key, value] of Object.entries(patch)) {
        if (value === null) delete merged[key];
        else merged[key] = value;
    }
    return merged;
}

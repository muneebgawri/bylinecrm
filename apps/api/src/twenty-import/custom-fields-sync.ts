import type { CustomFieldType } from '@bylinecrm/shared';
import { CUSTOM_PHONE, type FieldDefinition } from '../records/custom-fields/custom-values';
import {
    emailOf,
    isEnumLike,
    isObject,
    isoDate,
    isoDateTime,
    majorOf,
    nameOf,
    snakeKey,
    text,
    urlOf,
} from './twenty-records';

/** One custom value as read from Twenty: its type, as inferred, and the value; `null` is "cleared". */
export interface InferredValue {
    type: CustomFieldType;
    value: string | number | boolean;
    /** The label a definition made for it starts with; `labelOf(key)` when the importer has no better one. */
    label?: string | undefined;
}
export type InferredCustom = Record<string, InferredValue | null>;

/** A definition a page of records needs, merged with what the workspace has. */
export interface NeededDefinition {
    key: string;
    label: string;
    type: CustomFieldType;
    options: string[];
    /** The workspace has this key already: only new select options are to add. */
    existing: boolean;
}

/** Fields every Twenty record carries that are the record's bookkeeping, never a value of its own. */
const SYSTEM_FIELDS: ReadonlySet<string> = new Set([
    'id',
    'createdAt',
    'updatedAt',
    'deletedAt',
    'createdBy',
    'updatedBy',
    'position',
    'searchVector',
]);

/**
 * The fields Twenty added to an object (doc 48 §11: Pinion's own fields on people, companies and
 * deals), as values for BylineCRM's custom fields on the same object. The type is read from the
 * value: an instant, a date, a select option (`GOOGLE_ADS`), text; a number; a boolean; Twenty's
 * composites flattened — a currency to a number and `<key>_currency`, a link to a URL, an email,
 * a phone, a name. An empty answer (`""`, `null`) clears the field. Relations (arrays, other
 * objects) are not values and are left out. `exclude` names the fields the mapper read as
 * standard; `prefix` namespaces another object's fields on a person (`lead_`).
 */
export function inferCustomValues(
    record: Record<string, unknown>,
    exclude: ReadonlySet<string>,
    prefix = '',
): InferredCustom {
    const out: InferredCustom = {};
    for (const [field, value] of Object.entries(record)) {
        if (SYSTEM_FIELDS.has(field) || exclude.has(field)) continue;
        const key = keyOf(field, prefix);
        if (Array.isArray(value)) continue;
        if (value === null || value === undefined) {
            out[key] = null;
            continue;
        }
        if (typeof value === 'string') {
            out[key] = inferString(value);
            continue;
        }
        if (typeof value === 'number') {
            if (Number.isFinite(value)) out[key] = { type: 'number', value };
            continue;
        }
        if (typeof value === 'boolean') {
            out[key] = { type: 'boolean', value };
            continue;
        }
        if (isObject(value)) {
            if ('amountMicros' in value) {
                const money = majorOf(value);
                out[key] = money.amount === null ? null : { type: 'number', value: money.amount };
                out[`${key}_currency`] = money.currency === null ? null : { type: 'text', value: money.currency };
            } else if ('primaryLinkUrl' in value) {
                const url = urlOf(value.primaryLinkUrl);
                out[key] = url ? { type: 'url', value: url } : null;
            } else if ('primaryEmail' in value) {
                const email = emailOf(value.primaryEmail);
                out[key] = email ? { type: 'email', value: email } : null;
            } else if ('primaryPhoneNumber' in value) {
                const phone = text(value.primaryPhoneNumber);
                out[key] = phone ? { type: 'phone', value: phone } : null;
            } else if ('firstName' in value || 'lastName' in value) {
                const name = nameOf(value);
                const full = `${name.first} ${name.last}`.trim();
                out[key] = full ? { type: 'text', value: full } : null;
            }
            // Any other object is a relation or a shape this importer does not know: not a value.
        }
    }
    return out;
}

function inferString(value: string): InferredValue | null {
    const s = text(value);
    if (s === null) return null;
    if (isoDateTime(s)) return { type: 'datetime', value: s };
    if (/^\d{4}-\d{2}-\d{2}$/.test(s) && isoDate(s)) return { type: 'date', value: s };
    if (/^https?:\/\//i.test(s)) {
        const url = urlOf(s);
        if (url) return { type: 'url', value: url };
    }
    if (isEnumLike(s)) return { type: 'select', value: s };
    return { type: 'text', value: s };
}

/** The custom-field key of a Twenty field, under `prefix` unless the field already starts with it. */
export function keyOf(field: string, prefix = ''): string {
    const key = snakeKey(field);
    if (!prefix) return key;
    return key.startsWith(prefix) ? key : `${prefix}${key}`;
}

/** `pr_link` → `Pr link`: the label a definition gets; an admin renames it on the custom-fields screen. */
export function labelOf(key: string): string {
    const words = key.split('_').filter((w) => w !== '');
    return words.map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(' ');
}

/**
 * The definitions a page of records needs, in order of first appearance: a key the workspace has
 * keeps its type (a select grows the options the page brings); a key it has not takes the type of
 * the first value seen. A cleared value establishes nothing.
 */
export function definitionsNeeded(
    customs: readonly InferredCustom[],
    existing: readonly Pick<FieldDefinition, 'key' | 'type' | 'options'>[],
): NeededDefinition[] {
    const known = new Map(existing.map((d) => [d.key, d]));
    const needed = new Map<string, NeededDefinition>();
    for (const custom of customs) {
        for (const [key, inferred] of Object.entries(custom)) {
            if (!inferred) continue;
            let entry = needed.get(key);
            if (!entry) {
                const current = known.get(key);
                entry = current
                    ? { key, label: labelOf(key), type: current.type, options: [...current.options], existing: true }
                    : {
                          key,
                          label: inferred.label ?? labelOf(key),
                          type: inferred.type,
                          options: [],
                          existing: false,
                      };
                needed.set(key, entry);
            }
            if (
                (entry.type === 'select' || entry.type === 'multiselect') &&
                typeof inferred.value === 'string' &&
                !entry.options.includes(inferred.value)
            ) {
                entry.options.push(inferred.value);
            }
        }
    }
    return [...needed.values()];
}

/**
 * The values to write, each as its definition's type: a number stays a number, a select option
 * that the definition does not list is left out, anything else is written as the definition's
 * text when it can be. A key with no definition is not a value here.
 */
export function customValuesFor(
    custom: InferredCustom,
    definitions: readonly Pick<FieldDefinition, 'key' | 'type' | 'options'>[],
): Record<string, unknown> {
    const byKey = new Map(definitions.map((d) => [d.key, d]));
    const out: Record<string, unknown> = {};
    for (const [key, inferred] of Object.entries(custom)) {
        const definition = byKey.get(key);
        if (!definition) continue;
        if (inferred === null) {
            out[key] = null;
            continue;
        }
        const coerced = coerce(inferred, definition);
        if (coerced !== undefined) out[key] = coerced;
    }
    return out;
}

function coerce(inferred: InferredValue, definition: Pick<FieldDefinition, 'type' | 'options'>): unknown {
    const { value } = inferred;
    switch (definition.type) {
        case 'text':
            return String(value);
        case 'number': {
            const n = typeof value === 'number' ? value : Number(value);
            return Number.isFinite(n) && typeof value !== 'boolean' ? n : undefined;
        }
        case 'boolean':
            return typeof value === 'boolean' ? value : undefined;
        case 'select':
            return typeof value === 'string' && definition.options.includes(value) ? value : undefined;
        case 'multiselect':
            return typeof value === 'string' && definition.options.includes(value) ? [value] : undefined;
        case 'date':
            return typeof value === 'string' ? (isoDate(value) ?? undefined) : undefined;
        case 'datetime':
            return typeof value === 'string' ? (isoDateTime(value) ?? undefined) : undefined;
        case 'url':
            return typeof value === 'string' ? (urlOf(value) ?? undefined) : undefined;
        case 'email':
            return typeof value === 'string' ? (emailOf(value) ?? undefined) : undefined;
        case 'phone':
            // A value the field would refuse is left out, never the reason the whole record fails.
            return typeof value === 'string' && CUSTOM_PHONE.test(value) ? value : undefined;
    }
}

import { isFilterGroup, type FilterCondition, type FilterGroup, type FilterNode } from '@bylinecrm/shared';

/**
 * A filter travels in a URL (and so in a shared link) as base64url of its JSON — the form the API
 * decodes on every list, board and export route (P1-4). This module is the web app's one encoder
 * and decoder, and the small set of edits the filter chips make to a top-level `and` group.
 */

export function encodeFilter(filter: FilterGroup): string {
    const bytes = new TextEncoder().encode(JSON.stringify(filter));
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The filter in a URL parameter, or `null` when it is absent or not a filter group. */
export function decodeFilter(raw: string | null | undefined): FilterGroup | null {
    if (!raw) return null;
    try {
        const base64 = raw.replace(/-/g, '+').replace(/_/g, '/');
        const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
        const parsed: unknown = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0))));
        return isGroup(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

function isGroup(value: unknown): value is FilterGroup {
    return (
        typeof value === 'object' &&
        value !== null &&
        (Array.isArray((value as { and?: unknown }).and) || Array.isArray((value as { or?: unknown }).or))
    );
}

/**
 * The conditions the chips show and edit: those of a top-level `and`. A filter with `or` groups
 * (saved from elsewhere) is shown as one chip, "Advanced filter", and replaced whole if edited.
 */
export function chipConditions(filter: FilterGroup | null): FilterCondition[] | 'advanced' {
    if (!filter) return [];
    if (!('and' in filter)) return 'advanced';
    const nodes: FilterNode[] = filter.and;
    return nodes.every((node) => !isFilterGroup(node)) ? (nodes as FilterCondition[]) : 'advanced';
}

export function withCondition(filter: FilterGroup | null, condition: FilterCondition): FilterGroup {
    const current = chipConditions(filter);
    return { and: [...(current === 'advanced' ? [] : current), condition] };
}

/** The filter without its `index`-th chip; `null` when nothing is left. */
export function withoutCondition(filter: FilterGroup | null, index: number): FilterGroup | null {
    const current = chipConditions(filter);
    if (current === 'advanced') return null;
    const rest = current.filter((_, i) => i !== index);
    return rest.length ? { and: rest } : null;
}

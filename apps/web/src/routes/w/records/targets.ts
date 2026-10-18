import { RECORD_OBJECTS, type RecordObject, type RecordTarget } from '@bylinecrm/shared';
import { paths } from '../../paths';

/**
 * A record's address in a query string: `?open=person:<uuid>` opens its drawer over any page and
 * survives a refresh or a shared link. One parser; the same `type:id` spelling the API uses.
 */
export const OPEN_PARAM = 'open';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseTarget(value: string | null | undefined): RecordTarget | null {
    if (!value) return null;
    const [type, id] = value.split(':');
    if (!type || !id || !UUID.test(id)) return null;
    if (!(RECORD_OBJECTS as readonly string[]).includes(type)) return null;
    return { type: type as RecordObject, id };
}

export function formatTarget(target: RecordTarget): string {
    return `${target.type}:${target.id}`;
}

/** The current search with `open` set (or removed when `target` is null), nothing else touched. */
export function withOpen(search: string, target: RecordTarget | null): string {
    const params = new URLSearchParams(search);
    if (target) params.set(OPEN_PARAM, formatTarget(target));
    else params.delete(OPEN_PARAM);
    const text = params.toString();
    return text ? `?${text}` : '';
}

/** The one place a record object is named for a reader: "person", "company", "deal". */
export const OBJECT_LABEL: Record<RecordObject, string> = {
    person: 'Person',
    company: 'Company',
    opportunity: 'Deal',
};

/** A record's own page: a person's, a company's, a deal's. */
export function recordPath(workspaceId: string, target: RecordTarget): string {
    switch (target.type) {
        case 'person':
            return paths.person(workspaceId, target.id);
        case 'company':
            return paths.company(workspaceId, target.id);
        case 'opportunity':
            return paths.deal(workspaceId, target.id);
    }
}

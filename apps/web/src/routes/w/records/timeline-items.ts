import type { RecordObject } from '@bylinecrm/shared';
import type { TimelineActivityView } from '../../../api/types';
import { formatMoney } from '../../../lib/money';
import { fieldLabel } from './fields';
import { OBJECT_LABEL } from './targets';

export { fieldLabel };

/**
 * A timeline entry, read for a person: who did what. The API's `kind` is `<object>.<action>`,
 * `linked-<thing>.<action>` or `external.<name>`; this is the one translation of those into
 * words, and of an actor id into a name through the names the page already holds.
 */
export interface TimelineWords {
    /** "Dana Reyes", "A rule", "NewswireOS" */
    actor: string;
    /** "updated the record", "added a note", "paid an order" */
    action: string;
    /** `note`, `task`, `attachment`, `stage`, `external`, `record` — the marker's icon family. */
    family: 'record' | 'note' | 'task' | 'attachment' | 'stage' | 'external' | 'mail';
    /** The entry's origin when it is shown on a merged (company) timeline. */
    origin?: string;
    /** Supporting chips: a field diff, a stage move, an amount. */
    detail?: readonly { label: string; tone?: 'neutral' | 'accent' | 'success' }[];
}

export interface NameSources {
    members: ReadonlyMap<string, string>;
    /** Stage ids → names, for a deal's timeline; absent elsewhere. */
    stages?: ReadonlyMap<string, string>;
    /** The record the timeline belongs to; entries from another target are marked with it. */
    own: { type: RecordObject; id: string };
    recordNames?: ReadonlyMap<string, string>;
}

const ACTIONS: Record<string, string> = {
    created: 'created',
    updated: 'updated',
    deleted: 'deleted',
    restored: 'restored',
};

const THING: Record<string, string> = {
    note: 'a note',
    task: 'a task',
    attachment: 'a file',
};

export function wordsFor(entry: TimelineActivityView, names: NameSources): TimelineWords {
    const actor = actorName(entry, names);
    const origin =
        entry.target.type !== names.own.type || entry.target.id !== names.own.id
            ? `${OBJECT_LABEL[entry.target.type]}: ${names.recordNames?.get(entry.target.id) ?? '…'}`
            : undefined;
    const base = origin ? { actor, origin } : { actor };

    if (entry.kind.startsWith('external.')) {
        const title = typeof entry.properties['title'] === 'string' ? entry.properties['title'] : entry.kind.slice(9);
        const amount = entry.properties['amount'];
        const detail = isMoney(amount) ? [{ label: formatMoney(amount), tone: 'success' as const }] : undefined;
        return { ...base, action: title, family: 'external', ...(detail ? { detail } : {}) };
    }

    if (entry.kind.startsWith('linked-')) {
        const [thing = '', action = ''] = entry.kind.slice(7).split('.');
        const name = typeof entry.properties['name'] === 'string' ? entry.properties['name'] : undefined;
        const verb = action === 'created' ? 'added' : (ACTIONS[action] ?? action);
        return {
            ...base,
            action: `${verb} ${THING[thing] ?? thing}${name ? `: ${name}` : ''}`,
            family: thing === 'note' || thing === 'task' || thing === 'attachment' ? thing : 'record',
        };
    }

    const [object = '', action = ''] = entry.kind.split('.');
    if (object === 'deal') {
        return { ...base, ...stageWords(entry, names), family: 'stage' };
    }
    const diff = entry.properties['diff'];
    const detail = isRecord(diff)
        ? Object.keys(diff)
              .slice(0, 4)
              .map((field) => ({ label: fieldLabel(field) }))
        : undefined;
    return {
        ...base,
        action: `${ACTIONS[action] ?? action} the ${OBJECT_LABEL[object as RecordObject]?.toLowerCase() ?? object}`,
        family: 'record',
        ...(detail && detail.length ? { detail } : {}),
    };
}

/**
 * A stage move is stored as the event's diff, `properties.diff.stageId = { from, to }` (ids, as any
 * changed field is); the names come from the pipeline the page already holds.
 */
function stageWords(entry: TimelineActivityView, names: NameSources): Pick<TimelineWords, 'action' | 'detail'> {
    const diff = isRecord(entry.properties['diff']) ? entry.properties['diff'] : undefined;
    const move = diff && isRecord(diff['stageId']) ? diff['stageId'] : undefined;
    const from = typeof move?.['from'] === 'string' ? move['from'] : null;
    const to = typeof move?.['to'] === 'string' ? move['to'] : null;
    const action = entry.kind.endsWith('.won')
        ? 'won the deal'
        : entry.kind.endsWith('.lost')
          ? 'closed the deal as lost'
          : 'moved the deal';
    const nameOf = (id: string) => names.stages?.get(id) ?? 'a stage';
    const detail = to
        ? [
              ...(from ? [{ label: nameOf(from), tone: 'neutral' as const }] : []),
              { label: nameOf(to), tone: 'accent' as const },
          ]
        : undefined;
    return detail ? { action, detail } : { action };
}

function actorName(entry: TimelineActivityView, names: NameSources): string {
    switch (entry.actor.kind) {
        case 'member':
            return (entry.actor.id && names.members.get(entry.actor.id)) ?? 'A member';
        case 'rule':
            return 'A rule';
        case 'api_key':
            return 'An integration';
        case 'import':
            return 'An import';
        case 'sync':
            return 'Mail sync';
        case 'external':
            return entry.actor.id ?? 'An integration';
        case 'system':
            return 'The system';
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMoney(value: unknown): value is { amountMinor: number; currency: string } {
    return isRecord(value) && typeof value['amountMinor'] === 'number' && typeof value['currency'] === 'string';
}

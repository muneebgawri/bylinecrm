import type { RecordObject, SuppressionReason } from '@bylinecrm/shared';
import type { TimelineActivityView } from '../../../api/types';
import { formatDate, formatDay } from '../../../lib/format';
import { formatMoney } from '../../../lib/money';
import { SUPPRESSION_REASON_LABEL } from '../../../lib/suppression';
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
    family: 'record' | 'note' | 'task' | 'attachment' | 'stage' | 'external' | 'mail' | 'meeting';
    /** The entry's origin when it is shown on a merged (company) timeline. */
    origin?: string;
    /** Supporting chips: a field diff, a stage move, an amount. */
    detail?: readonly { label: string; tone?: 'neutral' | 'accent' | 'success' }[];
    /** An email entry's thread: the line opens it (doc 50 §A). */
    threadId?: string;
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

    if (entry.kind === 'linked-email.clicked' || entry.kind === 'linked-email.opened') {
        return { ...base, ...trackingWords(entry, names), family: 'mail' };
    }

    if (entry.kind.startsWith('linked-email.')) {
        return { ...base, ...emailWords(entry, names), family: 'mail' };
    }

    if (entry.kind.startsWith('linked-suppression.')) {
        return { ...base, ...suppressionWords(entry), family: 'mail' };
    }

    if (entry.kind.startsWith('linked-meeting.')) {
        return { ...base, ...meetingWords(entry, names), family: 'meeting' };
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
 * A meeting from a member's Google Calendar (CAL-1): the member it counts for booked it (or it was called
 * off), with its title and when it is — never its description.
 */
function meetingWords(
    entry: TimelineActivityView,
    names: NameSources,
): Pick<TimelineWords, 'actor' | 'action' | 'detail'> {
    const meeting = isRecord(entry.properties['meeting']) ? entry.properties['meeting'] : {};
    const title =
        typeof meeting['title'] === 'string' && meeting['title'] !== '' ? `“${meeting['title']}”` : 'a meeting';
    const host = typeof meeting['hostMemberId'] === 'string' ? names.members.get(meeting['hostMemberId']) : undefined;
    const startsAt = typeof meeting['startsAt'] === 'string' ? meeting['startsAt'] : null;
    const when = startsAt ? (meeting['allDay'] === true ? formatDay(startsAt) : formatDate(startsAt)) : null;
    const cancelled = entry.kind === 'linked-meeting.cancelled';
    const where = meeting['bookedVia'] === 'slotline' ? ' on Slotline' : '';
    return {
        actor: host ?? 'A member',
        action: cancelled ? `had ${title} cancelled` : `booked ${title}${where}${when ? ` for ${when}` : ''}`,
        ...(cancelled && when ? { detail: [{ label: when }] } : {}),
    };
}

/**
 * The person's address put on or lifted from the suppression list (#114): the address, why, and the
 * note — the entry's own note when added, the lift's note when lifted.
 */
function suppressionWords(entry: TimelineActivityView): Pick<TimelineWords, 'action' | 'detail'> {
    const linked = entry.properties['linked'];
    const address = isRecord(linked) && typeof linked['name'] === 'string' ? linked['name'] : 'an address';
    const suppression = entry.properties['suppression'];
    const reason = isRecord(suppression) ? suppression['reason'] : undefined;
    const note = isRecord(suppression) && typeof suppression['note'] === 'string' ? suppression['note'] : undefined;
    const detail = [
        ...(typeof reason === 'string' && reason in SUPPRESSION_REASON_LABEL
            ? [{ label: SUPPRESSION_REASON_LABEL[reason as SuppressionReason] }]
            : []),
        ...(note ? [{ label: note }] : []),
    ];
    return {
        action: entry.kind.endsWith('.removed') ? `lifted the suppression of ${address}` : `suppressed ${address}`,
        ...(detail.length ? { detail } : {}),
    };
}

/**
 * A click or an open on a sent email (P3-4, FR-CRMS-8): the person the entry is on did it (never the
 * system, whose event it is). A click names the link; an open says it is indicative, because a mail
 * client's prefetch looks the same as a read.
 */
function trackingWords(
    entry: TimelineActivityView,
    names: NameSources,
): Pick<TimelineWords, 'actor' | 'action' | 'detail'> {
    const tracking = isRecord(entry.properties['tracking']) ? entry.properties['tracking'] : {};
    const linked = isRecord(entry.properties['linked']) ? entry.properties['linked'] : {};
    const subject = typeof linked['name'] === 'string' && linked['name'] !== '' ? linked['name'] : null;
    const actor =
        names.recordNames?.get(entry.target.id) ??
        (entry.target.type === names.own.type && entry.target.id === names.own.id ? 'They' : 'The recipient');
    if (entry.kind === 'linked-email.opened') {
        return {
            actor,
            action: `opened ${subject ? `“${subject}”` : 'an email'} (indicative)`,
            detail: [{ label: 'Indicative: clients prefetch images' }],
        };
    }
    const url = typeof tracking['url'] === 'string' ? tracking['url'] : null;
    return {
        actor,
        action: `clicked ${url ?? 'a link'}${subject ? ` in “${subject}”` : ''}`,
    };
}

/**
 * A stored email on the record (P2-2): `properties.email` says which way it went, its subject and
 * its thread — never its body. Mail that came in is told by its sender's address; mail a member
 * sent, by the member when the entry names one.
 */
function emailWords(
    entry: TimelineActivityView,
    names: NameSources,
): Pick<TimelineWords, 'actor' | 'action' | 'threadId'> {
    const email = isRecord(entry.properties['email']) ? entry.properties['email'] : {};
    const subject = typeof email['subject'] === 'string' && email['subject'] !== '' ? email['subject'] : null;
    const from = typeof email['from'] === 'string' && email['from'] !== '' ? email['from'] : null;
    const threadId = typeof email['threadId'] === 'string' ? email['threadId'] : undefined;
    const sent = entry.kind === 'linked-email.sent';
    const member = entry.actor.kind === 'member' && entry.actor.id ? names.members.get(entry.actor.id) : undefined;
    const actor = (sent ? member : undefined) ?? from ?? actorName(entry, names);
    const what = subject ? `“${subject}”` : 'an email with no subject';
    return { actor, action: `${sent ? 'sent' : 'wrote'} ${what}`, ...(threadId ? { threadId } : {}) };
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
            return 'Google sync';
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

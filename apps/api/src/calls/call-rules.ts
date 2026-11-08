import { phoneTail, type CallDirection, type CallStatus } from '@bylinecrm/shared';
import type { QuoCall } from './quo.port';

/**
 * CALL-1's pure rules over a Quo call: which side is the outside number, what became of the call, and the SQL
 * pattern a person's stored phones are matched by. Unit-tested; no database.
 */

/** The outside party: the participant that is not the Quo user's own number. */
export function outsideNumber(call: QuoCall): string | null {
    const others = call.participants.filter((p) => p.actorId === null || p.actorId !== call.actorId);
    const external = others.find((p) => p.actorId === null) ?? others[0] ?? null;
    return external?.phoneNumber ?? null;
}

/** The Quo side: the participant with the call's actor, else the first with any actor. */
export function ownNumber(call: QuoCall): string | null {
    const own =
        call.participants.find((p) => p.actorId !== null && p.actorId === call.actorId) ??
        call.participants.find((p) => p.actorId !== null);
    return own?.phoneNumber ?? null;
}

export function directionOf(call: Pick<QuoCall, 'direction'>): CallDirection {
    return call.direction === 'outgoing' ? 'outbound' : 'inbound';
}

/** Quo's many statuses, read as the four the CRM shows. */
export function statusOf(call: Pick<QuoCall, 'status' | 'answeredAt' | 'voicemail'>): CallStatus {
    if (call.voicemail?.recordingUrl) return 'voicemail';
    switch (call.status) {
        case 'answered':
        case 'completed':
        case 'in-progress':
            return call.answeredAt || call.status !== 'completed' ? 'answered' : 'unanswered';
        case 'missed':
        case 'no-answer':
            return 'missed';
        default:
            return call.answeredAt ? 'answered' : 'unanswered';
    }
}

/**
 * The regex a person's `phones` JSON is searched with for a number: its last nine digits at the end of any stored
 * `number` (a trunk `0`, a calling code or a space before them changes nothing). Null for a number too short.
 */
export function phonesPattern(e164: string): string | null {
    const tail = phoneTail(e164);
    if (tail.length < 7) return null;
    // JSONB renders as text with a space after the colon; a regex tolerates either.
    return `"number":\\s*"[0-9]*${tail}"`;
}

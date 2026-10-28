import { CALENDAR_LINE_MAX_CHARS } from '../calendar.constants';
import type { ParsedAttendee, ParsedMeeting } from '../parse-event';
import { SLOTLINE_BOOKING_TRIGGERS, SLOTLINE_CANCEL_TRIGGERS, SLOTLINE_PING_TRIGGER } from './slotline.constants';

/** One person on a booking, as Slotline sends them. */
interface SlotlinePerson {
    email?: unknown;
    name?: unknown;
}

/** What a delivery says, once read: a booking to store, one to call off, a ping, or something the CRM does not read. */
export type SlotlineDelivery =
    | {
          kind: 'booking';
          uid: string;
          organizer: string;
          meeting: ParsedMeeting;
          /** A reschedule of a booking with no iCalendar UID: the booking it replaces. */
          replaces: string | null;
          /** A reschedule — the only delivery that may bring a cancelled booking back. */
          rescheduled: boolean;
      }
    | { kind: 'cancel'; uid: string; organizer: string; providerEventId: string }
    | { kind: 'ping' }
    | { kind: 'ignored'; reason: string };

/**
 * Reads a Slotline (Cal.com) webhook delivery — `{ triggerEvent, createdAt, payload }` — into what the
 * meeting store keeps (CAL-2). Never the booking's description, notes or answers to its questions.
 *
 * A booking's identity is its iCalendar UID: the same UID Slotline gives the event it writes into the
 * organiser's Google Calendar, so a booking and that event are one meeting. A reschedule keeps the UID, so
 * it moves the meeting rather than making a new one. The organiser is the member it is for; the attendees
 * (the person who booked, and any guests they added) are the people it is with.
 */
export function parseSlotlineDelivery(body: unknown): SlotlineDelivery {
    const root = record(body);
    const trigger = text(root['triggerEvent']);
    if (trigger === SLOTLINE_PING_TRIGGER) return { kind: 'ping' };
    const isBooking = (SLOTLINE_BOOKING_TRIGGERS as readonly string[]).includes(trigger);
    const isCancel = (SLOTLINE_CANCEL_TRIGGERS as readonly string[]).includes(trigger);
    if (!isBooking && !isCancel) return { kind: 'ignored', reason: `trigger ${trigger || '(none)'} is not read` };

    const payload = record(root['payload']);
    const uid = text(payload['uid']);
    const organizer = address(record(payload['organizer'])['email']);
    if (!uid || !organizer) return { kind: 'ignored', reason: 'the booking has no uid or organiser' };
    const icalUid = text(payload['iCalUID']) || `slotline:${uid}`;
    if (isCancel) return { kind: 'cancel', uid, organizer, providerEventId: icalUid };

    const startsAt = date(payload['startTime']);
    const endsAt = date(payload['endTime']);
    if (!startsAt || !endsAt) return { kind: 'ignored', reason: 'the booking has no start or end' };

    const organizerPerson = record(payload['organizer']) as SlotlinePerson;
    const attendees: ParsedAttendee[] = [
        {
            address: organizer,
            displayName: name(organizerPerson.name, organizer),
            responseStatus: 'accepted',
            isOrganizer: true,
            resource: false,
            self: true,
        },
    ];
    const seen = new Set([organizer]);
    const people = [
        ...list(payload['attendees']),
        // Hosts beside the organiser, when the booking has them: members, so never leads.
        ...list(record(payload['team'])['members']),
    ] as SlotlinePerson[];
    for (const person of people) {
        const email = address(person.email);
        if (!email || seen.has(email)) continue;
        seen.add(email);
        attendees.push({
            address: email,
            displayName: name(person.name, email),
            responseStatus: 'accepted',
            isOrganizer: false,
            resource: false,
            self: false,
        });
    }

    const location = line(payload['location']);
    const metadata = record(payload['metadata']);
    const conference = [record(payload['videoCallData'])['url'], metadata['videoCallUrl'], location].find(
        (value): value is string => typeof value === 'string' && /^https:\/\//i.test(value),
    );
    const pending = trigger === 'BOOKING_REQUESTED' || text(payload['status']).toUpperCase() === 'PENDING';
    const rescheduled = text(payload['rescheduleUid']);
    return {
        kind: 'booking',
        uid,
        organizer,
        replaces: !text(payload['iCalUID']) && rescheduled ? `slotline:${rescheduled}` : null,
        rescheduled: trigger === 'BOOKING_RESCHEDULED',
        meeting: {
            kind: 'meeting',
            providerEventId: icalUid,
            identityKey: icalUid,
            icalUid,
            title: line(payload['title']) ?? '',
            // An integration's name (`integrations:daily`) or a link is no place to go; an address is.
            location: location && !/^(integrations:|https?:\/\/)/i.test(location) ? location : null,
            conferenceUrl: conference ? conference.slice(0, CALENDAR_LINE_MAX_CHARS) : null,
            startsAt,
            endsAt: endsAt < startsAt ? startsAt : endsAt,
            allDay: false,
            status: pending ? 'tentative' : 'confirmed',
            organizerAddress: organizer,
            // When Slotline sent the creation: when it was booked. A later delivery never moves it (the store keeps the first).
            bookedAt: date(root['createdAt']) ?? new Date(),
            attendees,
            own: { responseStatus: 'accepted', isOrganizer: true },
        },
    };
}

/**
 * A booking as Slotline's admin route lists it, as the webhook delivery its last change sent — or would have,
 * had the CRM been up — so the catch-up reads it through `parseSlotlineDelivery`, the hook's own reading. Null
 * for the booking a reschedule replaced: Slotline marks it cancelled but sends no cancellation for it (it
 * shares its iCalendar UID with the new booking, whose reschedule moved the meeting), nor for a status the
 * hook never hears about.
 */
export function slotlineDeliveryFor(booking: Record<string, unknown>): unknown {
    if (booking['rescheduled'] === true) return null;
    const status = text(booking['status']).toUpperCase();
    const accepted = text(booking['rescheduleUid']) ? 'BOOKING_RESCHEDULED' : 'BOOKING_CREATED';
    const trigger = (
        {
            ACCEPTED: accepted,
            PENDING: 'BOOKING_REQUESTED',
            CANCELLED: 'BOOKING_CANCELLED',
            REJECTED: 'BOOKING_REJECTED',
        } as Record<string, string>
    )[status];
    if (!trigger) return null;
    const videoCallUrl = text(booking['videoCallUrl']);
    return {
        triggerEvent: trigger,
        // A creation's delivery is sent as it is booked: the booking's own creation is when it was booked.
        createdAt: booking['createdAt'],
        payload: { ...booking, ...(videoCallUrl ? { videoCallData: { url: videoCallUrl } } : {}) },
    };
}

function record(value: unknown): Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
}

function list(value: unknown): unknown[] {
    return Array.isArray(value) ? value.filter((v) => typeof v === 'object' && v !== null) : [];
}

function text(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function address(value: unknown): string | null {
    const email = text(value).toLowerCase();
    return email.includes('@') ? email : null;
}

/** A person's name as the booking shows it; a guest added by address alone has the address as their name. */
function name(value: unknown, email: string): string {
    const shown = text(value);
    return shown.toLowerCase() === email ? '' : shown;
}

function line(value: unknown): string | null {
    const shown = text(value).replace(/\s+/g, ' ');
    return shown ? shown.slice(0, CALENDAR_LINE_MAX_CHARS) : null;
}

function date(value: unknown): Date | null {
    if (typeof value !== 'string' || !value) return null;
    const at = new Date(value);
    return Number.isNaN(at.getTime()) ? null : at;
}

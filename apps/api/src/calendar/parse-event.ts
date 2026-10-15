import type { CalendarEventStatus, CalendarResponseStatus } from '@bylinecrm/shared';
import { CALENDAR_LINE_MAX_CHARS, CALENDAR_MEETING_TYPES, CALENDAR_PRIVATE_VISIBILITIES } from './calendar.constants';
import type { GoogleEventTime, GoogleRawEvent } from './google-calendar.port';

/** One attendee as sync keeps them: lower-case address, name, answer, and what Google says they are. */
export interface ParsedAttendee {
    address: string;
    displayName: string;
    responseStatus: CalendarResponseStatus;
    isOrganizer: boolean;
    /** A room or equipment: never a person. */
    resource: boolean;
    /** The calendar's own owner. */
    self: boolean;
}

/** A meeting read from one member's calendar, ready to classify and store. */
export interface ParsedMeeting {
    kind: 'meeting';
    providerEventId: string;
    /** Unique per meeting in the workspace (see `identityKeyOf`). */
    identityKey: string;
    icalUid: string;
    title: string;
    location: string | null;
    conferenceUrl: string | null;
    startsAt: Date;
    endsAt: Date;
    allDay: boolean;
    status: Exclude<CalendarEventStatus, 'cancelled'>;
    organizerAddress: string | null;
    bookedAt: Date;
    /** Everyone on the invitation, the organiser included, each once. */
    attendees: ParsedAttendee[];
    /** The calendar owner's own part: their answer, and whether they organised it. */
    own: { responseStatus: CalendarResponseStatus; isOrganizer: boolean };
}

export type ParsedEvent =
    | ParsedMeeting
    /** Called off (or the member taken off it): only Google's id is certain. */
    | { kind: 'cancelled'; providerEventId: string }
    /** Not a meeting (out of office, focus time, a private event, …), or missing what a meeting must have. */
    | { kind: 'skipped'; providerEventId: string };

/**
 * Turns one event as Google returns it into what sync keeps (CAL-1). A recurring meeting arrives one
 * occurrence at a time; each is its own meeting, and they share `icalUid` — the series, booked once.
 * The description is never read: a meeting's notes are its organiser's, not the CRM's.
 */
export function parseGoogleEvent(raw: GoogleRawEvent, mailboxId: string): ParsedEvent {
    const providerEventId = raw.id;
    if (raw.status === 'cancelled') return { kind: 'cancelled', providerEventId };
    if (!CALENDAR_MEETING_TYPES.includes(raw.eventType ?? 'default')) return { kind: 'skipped', providerEventId };
    // Marked private by its owner: their own business, whoever else is on it.
    if (CALENDAR_PRIVATE_VISIBILITIES.includes(raw.visibility ?? 'default'))
        return { kind: 'skipped', providerEventId };
    const start = timeOf(raw.start);
    const end = timeOf(raw.end);
    if (!start || !end) return { kind: 'skipped', providerEventId };

    const attendees = attendeesOf(raw);
    const own = attendees.find((a) => a.self);
    const organizerAddress = address(raw.organizer?.email);
    const icalUid = raw.iCalUID?.trim() || `google:${mailboxId}:${providerEventId}`;
    return {
        kind: 'meeting',
        providerEventId,
        identityKey: identityKeyOf(icalUid, raw.originalStartTime),
        icalUid,
        title: line(raw.summary) ?? '',
        location: line(raw.location),
        conferenceUrl: conferenceUrlOf(raw),
        startsAt: start.at,
        endsAt: end.at < start.at ? start.at : end.at,
        allDay: start.allDay,
        status: raw.status === 'tentative' ? 'tentative' : 'confirmed',
        organizerAddress,
        bookedAt: validDate(raw.created) ?? start.at,
        attendees,
        own: own
            ? { responseStatus: own.responseStatus, isOrganizer: own.isOrganizer || raw.organizer?.self === true }
            : // Not on the guest list: their own event (they organised it) or one put in their calendar for them.
              { responseStatus: 'accepted', isOrganizer: raw.organizer?.self === true || !raw.organizer },
    };
}

/**
 * A meeting's identity in the workspace: Google's iCalendar UID — the same in every guest's calendar —
 * and, for one occurrence of a recurring meeting, the start it has in the series (which stays put when
 * that one occurrence is moved).
 */
export function identityKeyOf(icalUid: string, originalStart: GoogleEventTime | undefined): string {
    if (!originalStart) return icalUid;
    const at = originalStart.dateTime ? validDate(originalStart.dateTime)?.toISOString() : originalStart.date;
    return at ? `${icalUid}#${at}` : icalUid;
}

/** Everyone on the invitation, once each, the organiser added when Google lists them only as organiser. */
function attendeesOf(raw: GoogleRawEvent): ParsedAttendee[] {
    const byAddress = new Map<string, ParsedAttendee>();
    for (const attendee of raw.attendees ?? []) {
        const email = address(attendee.email);
        if (!email || byAddress.has(email)) continue;
        byAddress.set(email, {
            address: email,
            displayName: (attendee.displayName ?? '').trim(),
            responseStatus: responseOf(attendee.responseStatus),
            isOrganizer: attendee.organizer === true,
            resource: attendee.resource === true,
            self: attendee.self === true,
        });
    }
    const organizer = address(raw.organizer?.email);
    if (organizer && !byAddress.has(organizer)) {
        byAddress.set(organizer, {
            address: organizer,
            displayName: (raw.organizer?.displayName ?? '').trim(),
            responseStatus: 'accepted',
            isOrganizer: true,
            resource: false,
            self: raw.organizer?.self === true,
        });
    }
    return [...byAddress.values()];
}

/** Google's answer names, in ours; anything unknown is no answer yet. */
function responseOf(value: string | undefined): CalendarResponseStatus {
    switch (value) {
        case 'accepted':
            return 'accepted';
        case 'tentative':
            return 'tentative';
        case 'declined':
            return 'declined';
        default:
            return 'needs_action';
    }
}

/** The video link: Meet's, or the first video entry point another conferencing provider put there. */
function conferenceUrlOf(raw: GoogleRawEvent): string | null {
    const link =
        raw.hangoutLink ?? raw.conferenceData?.entryPoints?.find((e) => e.entryPointType === 'video')?.uri ?? null;
    return link && /^https:\/\//i.test(link) ? link.slice(0, CALENDAR_LINE_MAX_CHARS) : null;
}

/** A timed start or end as a moment; an all-day one as midnight UTC of its date. */
function timeOf(time: GoogleEventTime | undefined): { at: Date; allDay: boolean } | null {
    if (time?.dateTime) {
        const at = validDate(time.dateTime);
        return at ? { at, allDay: false } : null;
    }
    if (time?.date && /^\d{4}-\d{2}-\d{2}$/.test(time.date)) {
        const at = validDate(`${time.date}T00:00:00Z`);
        return at ? { at, allDay: true } : null;
    }
    return null;
}

function validDate(value: string | undefined): Date | null {
    if (!value) return null;
    const at = new Date(value);
    return Number.isNaN(at.getTime()) ? null : at;
}

function address(value: string | undefined): string | null {
    const email = value?.trim().toLowerCase();
    return email && email.includes('@') ? email : null;
}

function line(value: string | undefined): string | null {
    const text = value?.replace(/\s+/g, ' ').trim();
    return text ? text.slice(0, CALENDAR_LINE_MAX_CHARS) : null;
}

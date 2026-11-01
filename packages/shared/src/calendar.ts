import { GMAIL_READONLY_SCOPE, GMAIL_SEND_SCOPE } from './mail.js';

/**
 * Contact pictures (AVATAR-1, ported from BylineAI's Google Contacts avatars): read the member's
 * Google contacts — the ones they saved, and the "other contacts" Gmail keeps for everyone they have
 * written to — for the picture on a lead's address. Read-only, never a write. Optional like the
 * calendar's: asked for beside the Gmail scopes, and the mailbox works without them.
 */
export const GOOGLE_CONTACTS_SCOPE = 'https://www.googleapis.com/auth/contacts.readonly';
export const GOOGLE_OTHER_CONTACTS_SCOPE = 'https://www.googleapis.com/auth/contacts.other.readonly';
export const GOOGLE_CONTACTS_SCOPES = [GOOGLE_CONTACTS_SCOPE, GOOGLE_OTHER_CONTACTS_SCOPE] as const;

/**
 * Calendar sync (CAL-1, owner request 2026-10-15): each member's Google Calendar, read through the same
 * connection as their personal mailbox, so the meetings they book and hold with people outside the
 * workspace count towards their KPIs and every outside attendee is a lead they own. One vocabulary for
 * the API, the web app and the tests.
 */

/**
 * Read the events on the member's calendars — nothing else: not the calendar list, not settings, never
 * a write. Asked for beside the two Gmail scopes when a personal mailbox connects; granted or not,
 * the mailbox works (Google's consent screen lets a person untick it), and calendar sync runs only
 * while the grant carries it.
 */
export const GOOGLE_CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events.readonly';

/**
 * What a personal mailbox's connect asks Google for: Gmail's two narrow scopes, the calendar's
 * read-only one and the two contacts ones. Only Gmail's are required (`GMAIL_SCOPES`); the setup
 * screen lists them all, since the workspace's consent screen must allow each one it will be asked for.
 */
export const PERSONAL_MAILBOX_SCOPES = [
    GMAIL_SEND_SCOPE,
    GMAIL_READONLY_SCOPE,
    GOOGLE_CALENDAR_SCOPE,
    ...GOOGLE_CONTACTS_SCOPES,
] as const;

/**
 * What the Google Workspace service account (#225) is authorised for in the Admin console, and all it ever
 * asks for: exactly what a member's own OAuth connection asks for — Gmail send, Gmail read, calendar
 * events and contacts read-only — so a delegated member syncs and sends (composer and sequences) like a
 * connected one. Each scope is checked on its own; a token is minted only for those the console allows.
 */
export const DELEGATION_SCOPES = PERSONAL_MAILBOX_SCOPES;

/**
 * What the delegation's audit log records (#225): key and domain changes, exclusion toggles, a member's
 * first delegated sync (and their first again after a gap or an exclusion change), and a delegated sync
 * failing — once per member until it works again. Not every sync: they run every few minutes.
 */
export const DELEGATION_AUDIT_ACTIONS = [
    'key_set',
    'key_removed',
    'domains_changed',
    'member_excluded',
    'member_included',
    'sync_started',
    'sync_failed',
] as const;
export type DelegationAuditAction = (typeof DELEGATION_AUDIT_ACTIONS)[number];

/** How a workspace member stands with delegation (#225), as the settings page lists them. */
export const DELEGATION_MEMBER_STATES = ['delegated', 'own_connection', 'excluded', 'outside_domains'] as const;
export type DelegationMemberState = (typeof DELEGATION_MEMBER_STATES)[number];

/** True when a mailbox's grant lets the Google Contacts source read its contacts (either kind). */
export function contactsGranted(grantedScopes: readonly string[]): boolean {
    return GOOGLE_CONTACTS_SCOPES.some((scope) => grantedScopes.includes(scope));
}

/** True when a mailbox's grant lets calendar sync read its calendar. */
export function calendarGranted(grantedScopes: readonly string[]): boolean {
    return grantedScopes.includes(GOOGLE_CALENDAR_SCOPE);
}

/** A meeting as Google reports it: `cancelled` once its organiser cancels it (or removes the member). */
export const CALENDAR_EVENT_STATUSES = ['confirmed', 'tentative', 'cancelled'] as const;
export type CalendarEventStatus = (typeof CALENDAR_EVENT_STATUSES)[number];

/** Where a meeting reached the CRM from: a member's Google Calendar, or a booking on Slotline (CAL-2). */
export const MEETING_SOURCES = ['google_calendar', 'slotline'] as const;
export type MeetingSource = (typeof MEETING_SOURCES)[number];

/** An attendee's answer to the invitation, as Google reports it. */
export const CALENDAR_RESPONSE_STATUSES = ['needs_action', 'accepted', 'tentative', 'declined'] as const;
export type CalendarResponseStatus = (typeof CALENDAR_RESPONSE_STATUSES)[number];

/**
 * What a `meeting.booked` / `meeting.cancelled` event carries about the meeting, beside the records it
 * concerns (`targets`, `related`): enough for the timeline to show it. Never its description.
 */
export type MeetingSummary = {
    /** The CRM's meeting id (`recordId` of the event). */
    meetingId: string;
    title: string;
    /** ISO 8601, UTC. */
    startsAt: string;
    endsAt: string;
    allDay: boolean;
    /** The Meet (or other video) link, when the meeting has one. */
    conferenceUrl: string | null;
    /** The member whose calendar it was found in, who the meeting counts for. */
    hostMemberId: string;
    /** ISO 8601, UTC: when the meeting was put in the calendar (Google's creation time), or booked on Slotline. */
    bookedAt: string;
    /** Booked through the workspace's Slotline booking site (CAL-2), or found in a member's calendar. */
    bookedVia: MeetingSource;
};

/** The KPI periods the Team page offers; the API takes any `from`/`to` within the limit. */
export const MEETING_KPI_MAX_DAYS = 366;

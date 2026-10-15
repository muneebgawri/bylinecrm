/**
 * Every number and fixed string calendar sync (CAL-1) runs on, in one place. A value here is a
 * decision; the code that uses it says what it is for, never repeats it.
 */

/** How far back a calendar's first read reaches: meetings held in the last 30 days count from day one. */
export const CALENDAR_INITIAL_DAYS = 30;
/** How far back a later full read of the window reaches: a meeting edited after it was held is still seen. */
export const CALENDAR_RECENT_DAYS = 2;
/**
 * How far ahead every read reaches. A recurring meeting is read one occurrence at a time, so an open-ended
 * series has to stop somewhere; a booking further out than this is seen once it comes within it.
 */
export const CALENDAR_HORIZON_DAYS = 60;
/**
 * How often a run reads the whole window instead of only what changed since the last run: the way
 * occurrences of a recurring meeting that have come within the horizon (unchanged, so never "updated")
 * are found.
 */
export const CALENDAR_WINDOW_READ_EVERY_MS = 24 * 60 * 60 * 1000;
/** A changes-only read starts this long before the previous run started, so nothing between the two is missed. */
export const CALENDAR_UPDATED_MARGIN_MS = 5 * 60 * 1000;

/**
 * A meeting with more attendees than this is a webinar, a town hall or an all-hands, not a meeting with
 * a client: it is not kept, and none of its attendees becomes a lead.
 */
export const CALENDAR_MAX_ATTENDEES = 25;

/**
 * Domains Google itself uses for attendees who are not people — rooms and equipment, group and shared
 * calendars. Never outside attendees, never leads.
 */
export const CALENDAR_NON_PERSON_DOMAIN = /(^|\.)calendar\.google\.com$/;

/**
 * Google's kinds of calendar entry that are a meeting. Out-of-office blocks, focus time, working
 * locations, birthdays and the bookings Gmail adds by itself (flights, restaurants) are not.
 */
export const CALENDAR_MEETING_TYPES: readonly string[] = ['default'];

/**
 * Visibilities that mark an event as its owner's own business — a doctor's appointment, an interview
 * elsewhere. Never read: not kept, never a lead, never shown to an admin.
 */
export const CALENDAR_PRIVATE_VISIBILITIES: readonly string[] = ['private', 'confidential'];

/** What a person created from a meeting's attendee has as `source` (FR-CRMS-11: where they came from). */
export const CALENDAR_LEAD_SOURCE = 'Google Calendar';

/** A meeting's title and location are kept up to this length. */
export const CALENDAR_LINE_MAX_CHARS = 1_000;

/** Events asked for per page (Google allows up to 2,500). */
export const CALENDAR_PAGE_SIZE = 250;
/** One Calendar request may take this long before it is abandoned. */
export const CALENDAR_HTTP_TIMEOUT_MS = 15_000;
/** Google Calendar's REST base for the signed-in user's primary calendar. The HTTP adapter is the only code that calls it. */
export const CALENDAR_API_BASE = 'https://www.googleapis.com/calendar/v3/calendars/primary';

/** Attempts per Calendar request on `429`, a `5xx` or no answer, before the run gives up (it is retried later). */
export const CALENDAR_RETRY_ATTEMPTS = 4;

/** The queue every calendar's sync runs on; a job's id is its mailbox's, so one runs at a time. */
export const CALENDAR_SYNC_QUEUE = 'calendar-sync';
/** How often every calendar is read. A booking is seen within this long; KPIs need nothing fresher. */
export const CALENDAR_SYNC_EVERY_MS = 10 * 60 * 1000;
/** Calendar runs at once in one worker process. */
export const CALENDAR_SYNC_WORKER_CONCURRENCY = 2;
/** A failed run is retried this many times, with the queue's exponential backoff from this base. */
export const CALENDAR_SYNC_JOB_ATTEMPTS = 3;
export const CALENDAR_SYNC_JOB_BACKOFF_MS = 30_000;

/** Page sizes for the meetings list. */
export const MEETINGS_LIMIT_DEFAULT = 30;
export const MEETINGS_LIMIT_MAX = 100;

/**
 * Attempts at storing one copy. Two members' runs may store the first copy of one meeting at once; the
 * second attempt of the run that lost finds the meeting and stores its copy beside it.
 */
export const CALENDAR_STORE_ATTEMPTS = 2;

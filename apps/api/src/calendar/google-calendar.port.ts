/**
 * Everything calendar sync (CAL-1) asks Google Calendar, behind one interface. The HTTP adapter
 * (`google-calendar.http.ts`) is the only code that calls it; tests bind an in-memory fake
 * (`test/support/fake-google-calendar.ts`), so no test and no CI run ever reaches Google.
 *
 * The shapes are Google's own (events.list), trimmed to what sync reads, so `parse-event.ts` turns
 * exactly what Google returns into a meeting — one parser for the adapter and the fake alike.
 */

/** A start or an end: `dateTime` for a timed event, `date` (YYYY-MM-DD) for an all-day one. */
export interface GoogleEventTime {
    dateTime?: string;
    date?: string;
}

export interface GoogleEventAttendee {
    email?: string;
    displayName?: string;
    organizer?: boolean;
    /** The calendar's own owner. */
    self?: boolean;
    /** A room or a piece of equipment. */
    resource?: boolean;
    responseStatus?: string;
}

/** One event as Google returns it. A cancelled one may carry little more than its id and status. */
export interface GoogleRawEvent {
    id: string;
    status?: string;
    /** `default`, or a kind that is not a meeting (`outOfOffice`, `focusTime`, …). */
    eventType?: string;
    /** `default`, `public`, `private` or `confidential`: who besides the guests may see it. */
    visibility?: string;
    iCalUID?: string;
    summary?: string;
    location?: string;
    /** RFC 3339: when the event was created — when the meeting was booked. */
    created?: string;
    updated?: string;
    start?: GoogleEventTime;
    end?: GoogleEventTime;
    /** Set on one occurrence of a recurring event: the series' id, and the start it had in the series. */
    recurringEventId?: string;
    originalStartTime?: GoogleEventTime;
    organizer?: { email?: string; displayName?: string; self?: boolean };
    attendees?: GoogleEventAttendee[];
    hangoutLink?: string;
    conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[] };
}

export interface GoogleEventPage {
    items: GoogleRawEvent[];
    nextPageToken: string | null;
}

/**
 * Google answered with an error or failed to answer. `status` is the HTTP status (`null` for a network
 * failure or a timeout); `reason` is Google's (`rateLimitExceeded`, `insufficientPermissions`, …) or the
 * adapter's own (`network`, `timeout`, `unexpected_response`). The message never holds a token.
 */
export class GoogleCalendarError extends Error {
    constructor(
        readonly status: number | null,
        readonly reason: string,
        message: string,
    ) {
        super(message);
        this.name = 'GoogleCalendarError';
    }

    /** Worth retrying the same request after a wait: throttled, a server error, or no answer. */
    get transient(): boolean {
        return (
            this.status === null ||
            this.status === 429 ||
            this.status >= 500 ||
            (this.status === 403 && /rateLimitExceeded/i.test(this.reason))
        );
    }

    /**
     * The grant does not let the API read the calendar: the scope was withdrawn in the Google account.
     * Nothing to retry until the person connects again.
     */
    get scopeMissing(): boolean {
        return this.status === 403 && /insufficientPermissions|PERMISSION_DENIED/i.test(this.reason);
    }

    /**
     * The workspace's Google Cloud project has not turned the Calendar API on: an admin's setup step,
     * not the member's — reconnecting would not help.
     */
    get apiDisabled(): boolean {
        return this.status === 403 && /accessNotConfigured|SERVICE_DISABLED/i.test(this.reason);
    }
}

export interface GoogleCalendarPort {
    /**
     * One page of the primary calendar's events in `[timeMin, timeMax)`, recurring meetings one
     * occurrence at a time, cancelled ones included. With `updatedMin`, only those changed since.
     */
    listEvents(
        accessToken: string,
        input: { timeMin: Date; timeMax: Date; updatedMin?: Date; pageToken?: string },
    ): Promise<GoogleEventPage>;
}

/** Injection token for the port. */
export const GOOGLE_CALENDAR_PORT = Symbol('GOOGLE_CALENDAR_PORT');

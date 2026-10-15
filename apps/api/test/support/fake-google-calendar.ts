import { GOOGLE_CALENDAR_SCOPE } from '@bylinecrm/shared';
import {
    GoogleCalendarError,
    type GoogleCalendarPort,
    type GoogleEventPage,
    type GoogleRawEvent,
} from '../../src/calendar/google-calendar.port';
import { assertNoOpenTransaction } from '../../src/infra/transaction-scope';
import type { FakeGoogleOAuth } from './fake-google-oauth';

/** A meeting to put in a fixture calendar. Defaults make a confirmed 30-minute meeting the owner organises. */
export interface FixtureMeeting {
    id: string;
    summary?: string;
    start: Date;
    /** Minutes; 30 by default. */
    minutes?: number;
    /** When it was booked (Google's `created`); now by default. */
    created?: Date;
    iCalUID?: string;
    /** The organiser; the calendar's owner by default. */
    organizer?: string;
    /** Everyone else on the invitation, with their answers (accepted by default). */
    guests?: { email: string; displayName?: string; responseStatus?: string; resource?: boolean }[];
    /** The calendar owner's own answer when they are a guest. */
    ownResponse?: string;
    eventType?: string;
    visibility?: string;
    recurringEventId?: string;
    originalStart?: Date;
}

/**
 * An in-memory Google Calendar for the tests: no network, ever. Access tokens are the fake OAuth's — a
 * token resolves to the account its grant is for, a revoked grant is refused, and a grant without the
 * calendar scope is `403` — so sync passes only if it uses the token `MailboxTokens` hands out and reads
 * only calendars it was allowed to. Events are built as Google returns them, so the real parser reads them.
 */
export class FakeGoogleCalendar implements GoogleCalendarPort {
    private readonly calendars = new Map<string, Map<string, GoogleRawEvent>>();
    private readonly failures: { email: string; status: number; remaining: number; reason?: string }[] = [];
    /**
     * A guest's view of a meeting whose guest list is hidden (`guestsCanSeeOtherGuests: false`): Google
     * shows the guest only themselves and the organiser.
     */
    hideGuests(owner: string, id: string): void {
        const event = this.calendar(owner).get(id);
        if (!event) throw new Error(`fake Calendar: no event ${id} for ${owner}`);
        event.attendees = (event.attendees ?? []).filter((a) => a.self || a.organizer);
        event.updated = new Date().toISOString();
    }

    /** Every call made, for assertions. */
    readonly calls: { email: string; updatedMin: string | null; timeMin: string; timeMax: string }[] = [];
    /** Small enough that the tests exercise paging. */
    pageSize = 2;

    constructor(private readonly oauth: FakeGoogleOAuth) {}

    // ── Fixture control ─────────────────────────────────────────────────────────────────────

    /** Puts (or replaces) a meeting in the owner's calendar, as changed now. */
    put(owner: string, fixture: FixtureMeeting): GoogleRawEvent {
        const organizer = fixture.organizer ?? owner;
        const end = new Date(fixture.start.getTime() + (fixture.minutes ?? 30) * 60_000);
        const ownIsOrganizer = organizer === owner;
        const event: GoogleRawEvent = {
            id: fixture.id,
            status: 'confirmed',
            eventType: fixture.eventType ?? 'default',
            ...(fixture.visibility ? { visibility: fixture.visibility } : {}),
            iCalUID: fixture.iCalUID ?? `${fixture.id}@google.com`,
            summary: fixture.summary ?? 'Meeting',
            created: (fixture.created ?? new Date()).toISOString(),
            updated: new Date().toISOString(),
            start: { dateTime: fixture.start.toISOString() },
            end: { dateTime: end.toISOString() },
            organizer: { email: organizer, ...(ownIsOrganizer ? { self: true } : {}) },
            attendees: [
                {
                    email: owner,
                    self: true,
                    ...(ownIsOrganizer ? { organizer: true } : {}),
                    responseStatus: fixture.ownResponse ?? 'accepted',
                },
                ...(fixture.guests ?? []).map((g) => ({
                    email: g.email,
                    ...(g.displayName ? { displayName: g.displayName } : {}),
                    ...(g.resource ? { resource: true } : {}),
                    ...(g.email === organizer ? { organizer: true } : {}),
                    responseStatus: g.responseStatus ?? 'accepted',
                })),
            ],
            hangoutLink: `https://meet.google.com/${fixture.id}`,
            ...(fixture.recurringEventId ? { recurringEventId: fixture.recurringEventId } : {}),
            ...(fixture.originalStart ? { originalStartTime: { dateTime: fixture.originalStart.toISOString() } } : {}),
        };
        this.calendar(owner).set(event.id, event);
        return event;
    }

    /** The organiser called it off: Google keeps only the id and the status, changed now. */
    cancel(owner: string, id: string): void {
        const events = this.calendar(owner);
        const event = events.get(id);
        if (!event) throw new Error(`fake Calendar: no event ${id} for ${owner}`);
        events.set(id, {
            id,
            status: 'cancelled',
            updated: new Date().toISOString(),
            ...(event.start ? { start: event.start } : {}),
        });
    }

    /** The next `times` calls for this account fail with `status` (and Google's `reason`, when given). */
    failNext(email: string, status: number, times = 1, reason?: string): void {
        this.failures.push({ email, status, remaining: times, ...(reason ? { reason } : {}) });
    }

    callsFor(email: string): number {
        return this.calls.filter((c) => c.email === email).length;
    }

    // ── The port ─────────────────────────────────────────────────────────────────────────────

    async listEvents(
        accessToken: string,
        input: { timeMin: Date; timeMax: Date; updatedMin?: Date; pageToken?: string },
    ): Promise<GoogleEventPage> {
        assertNoOpenTransaction('Google Calendar listEvents');
        let email: string;
        let scopes: string[];
        try {
            email = await this.oauth.mailboxAddress(accessToken);
            scopes = await this.oauth.grantedScopes(accessToken);
        } catch {
            throw new GoogleCalendarError(401, 'authError', 'Google Calendar answered 401 (authError)');
        }
        this.calls.push({
            email,
            updatedMin: input.updatedMin?.toISOString() ?? null,
            timeMin: input.timeMin.toISOString(),
            timeMax: input.timeMax.toISOString(),
        });
        if (!scopes.includes(GOOGLE_CALENDAR_SCOPE)) {
            throw new GoogleCalendarError(403, 'insufficientPermissions', 'Google Calendar answered 403');
        }
        const failure = this.failures.find((f) => f.email === email && f.remaining > 0);
        if (failure) {
            failure.remaining -= 1;
            throw new GoogleCalendarError(
                failure.status,
                failure.reason ?? (failure.status === 429 ? 'rateLimitExceeded' : 'backendError'),
                `Google Calendar answered ${failure.status}`,
            );
        }
        const matching = [...this.calendar(email).values()].filter((event) => {
            const start = event.start?.dateTime ? new Date(event.start.dateTime) : null;
            if (start && (start < input.timeMin || start >= input.timeMax)) return false;
            return !input.updatedMin || new Date(event.updated ?? 0) >= input.updatedMin;
        });
        const offset = input.pageToken ? Number(input.pageToken) : 0;
        const items = matching.slice(offset, offset + this.pageSize);
        const next = offset + this.pageSize;
        return { items: structuredClone(items), nextPageToken: next < matching.length ? String(next) : null };
    }

    private calendar(email: string): Map<string, GoogleRawEvent> {
        let events = this.calendars.get(email);
        if (!events) {
            events = new Map();
            this.calendars.set(email, events);
        }
        return events;
    }
}

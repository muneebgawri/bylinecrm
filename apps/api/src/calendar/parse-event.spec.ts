import { describe, expect, it } from 'vitest';
import type { GoogleRawEvent } from './google-calendar.port';
import { nameFromDisplay, outsideAttendees } from './outside';
import { identityKeyOf, parseGoogleEvent, type ParsedAttendee, type ParsedMeeting } from './parse-event';

const MAILBOX = '00000000-0000-4000-8000-000000000001';

function meeting(overrides: Partial<GoogleRawEvent> = {}): GoogleRawEvent {
    return {
        id: 'evt1',
        status: 'confirmed',
        eventType: 'default',
        iCalUID: 'abc@google.com',
        summary: '  Intro   call ',
        created: '2026-10-01T09:00:00Z',
        start: { dateTime: '2026-10-20T15:00:00+02:00' },
        end: { dateTime: '2026-10-20T15:30:00+02:00' },
        organizer: { email: 'Sam@Pinion.example', self: true },
        attendees: [
            { email: 'sam@pinion.example', self: true, organizer: true, responseStatus: 'accepted' },
            { email: 'Dana@Acme.example', displayName: 'Dana Reyes', responseStatus: 'needsAction' },
            { email: 'room-1@resource.calendar.google.com', resource: true, responseStatus: 'accepted' },
        ],
        hangoutLink: 'https://meet.google.com/abc-defg-hij',
        ...overrides,
    };
}

function parsed(raw: GoogleRawEvent): ParsedMeeting {
    const result = parseGoogleEvent(raw, MAILBOX);
    if (result.kind !== 'meeting') throw new Error(`expected a meeting, got ${result.kind}`);
    return result;
}

describe('parseGoogleEvent (CAL-1)', () => {
    it('reads a timed meeting: times in UTC, the Meet link, booked when created, the title tidied', () => {
        const m = parsed(meeting());
        expect(m).toMatchObject({
            providerEventId: 'evt1',
            identityKey: 'abc@google.com',
            icalUid: 'abc@google.com',
            title: 'Intro call',
            allDay: false,
            status: 'confirmed',
            organizerAddress: 'sam@pinion.example',
            conferenceUrl: 'https://meet.google.com/abc-defg-hij',
            own: { responseStatus: 'accepted', isOrganizer: true },
        });
        expect(m.startsAt.toISOString()).toBe('2026-10-20T13:00:00.000Z');
        expect(m.endsAt.toISOString()).toBe('2026-10-20T13:30:00.000Z');
        expect(m.bookedAt.toISOString()).toBe('2026-10-01T09:00:00.000Z');
    });

    it('lower-cases every address, maps Google’s answers, and lists each attendee once', () => {
        const m = parsed(
            meeting({
                attendees: [
                    { email: 'sam@pinion.example', self: true, responseStatus: 'declined' },
                    { email: 'DANA@acme.example', responseStatus: 'tentative' },
                    { email: 'dana@acme.example', responseStatus: 'accepted' },
                ],
                organizer: { email: 'lee@acme.example', displayName: 'Lee' },
            }),
        );
        expect(m.attendees.map((a) => [a.address, a.responseStatus, a.isOrganizer])).toEqual([
            ['sam@pinion.example', 'declined', false],
            ['dana@acme.example', 'tentative', false],
            // The organiser, listed by Google only as organiser, is on the invitation too.
            ['lee@acme.example', 'accepted', true],
        ]);
        expect(m.own).toEqual({ responseStatus: 'declined', isOrganizer: false });
    });

    it('an all-day meeting starts and ends at midnight UTC of its dates', () => {
        const m = parsed(meeting({ start: { date: '2026-10-20' }, end: { date: '2026-10-21' } }));
        expect(m.allDay).toBe(true);
        expect(m.startsAt.toISOString()).toBe('2026-10-20T00:00:00.000Z');
        expect(m.endsAt.toISOString()).toBe('2026-10-21T00:00:00.000Z');
    });

    it('one occurrence of a recurring meeting is its own meeting, keyed by its place in the series', () => {
        const m = parsed(
            meeting({
                id: 'evt1_20261020T130000Z',
                recurringEventId: 'evt1',
                originalStartTime: { dateTime: '2026-10-20T15:00:00+02:00' },
            }),
        );
        expect(m.icalUid).toBe('abc@google.com');
        expect(m.identityKey).toBe('abc@google.com#2026-10-20T13:00:00.000Z');
        expect(identityKeyOf('u', { date: '2026-10-20' })).toBe('u#2026-10-20');
    });

    it('a cancelled event is only its id; out of office, focus time and malformed events are not meetings', () => {
        expect(parseGoogleEvent({ id: 'x', status: 'cancelled' }, MAILBOX)).toEqual({
            kind: 'cancelled',
            providerEventId: 'x',
        });
        expect(parseGoogleEvent(meeting({ eventType: 'outOfOffice' }), MAILBOX).kind).toBe('skipped');
        expect(parseGoogleEvent(meeting({ eventType: 'focusTime' }), MAILBOX).kind).toBe('skipped');
        expect(parseGoogleEvent(meeting({ start: {} }), MAILBOX).kind).toBe('skipped');
    });

    it('a private or confidential event is the owner’s own business: never a meeting, whoever is on it', () => {
        expect(parseGoogleEvent(meeting({ visibility: 'private' }), MAILBOX).kind).toBe('skipped');
        expect(parseGoogleEvent(meeting({ visibility: 'confidential' }), MAILBOX).kind).toBe('skipped');
        expect(parseGoogleEvent(meeting({ visibility: 'public' }), MAILBOX).kind).toBe('meeting');
    });

    it('the owner organised it when Google says so on the organiser, even if their guest entry does not', () => {
        const m = parsed(
            meeting({
                attendees: [
                    { email: 'sam@pinion.example', self: true, responseStatus: 'accepted' },
                    { email: 'dana@acme.example' },
                ],
            }),
        );
        expect(m.own).toEqual({ responseStatus: 'accepted', isOrganizer: true });
    });

    it('never keeps a link that is not https, and falls back to another provider’s video entry point', () => {
        expect(parsed(meeting({ hangoutLink: 'javascript:alert(1)' })).conferenceUrl).toBeNull();
        const zoom = meeting({
            conferenceData: { entryPoints: [{ entryPointType: 'video', uri: 'https://zoom.example/j/1' }] },
        });
        delete zoom.hangoutLink;
        expect(parsed(zoom).conferenceUrl).toBe('https://zoom.example/j/1');
    });

    it('an event with no iCalendar UID is still one meeting per calendar and id', () => {
        const raw = meeting();
        delete raw.iCalUID;
        expect(parsed(raw).identityKey).toBe(`google:${MAILBOX}:evt1`);
    });
});

describe('outsideAttendees (CAL-1)', () => {
    const attendee = (address: string, extra: Partial<ParsedAttendee> = {}): ParsedAttendee => ({
        address,
        displayName: '',
        responseStatus: 'accepted',
        isOrganizer: false,
        resource: false,
        self: false,
        ...extra,
    });
    const owner = 'sam@pinion.example';

    it('keeps people outside the workspace and passes over everyone inside it', () => {
        const attendees = [
            attendee(owner, { self: true }),
            attendee('dana@acme.example'),
            attendee('lee@pinion.example'), // a colleague at the owner's work domain
            attendee('kim@member.example'), // a member signing in from elsewhere
            attendee('jo@member.example'), // a colleague at that member's work domain
            attendee('room@resource.calendar.google.com', { resource: true }),
            attendee('team@group.calendar.google.com'),
            attendee('noisy@vendor.example'), // on the blocklist
            attendee('x@spam.example'), // a blocklisted domain
        ];
        const outside = outsideAttendees({
            ownerAddress: owner,
            attendees,
            insiders: new Set(['kim@member.example', owner]),
            blocklist: ['noisy@vendor.example', '@spam.example'],
        });
        expect(outside.map((a) => a.address)).toEqual(['dana@acme.example']);
    });

    it('a free-mail owner has no colleagues by domain: everyone else at gmail.com is outside', () => {
        const outside = outsideAttendees({
            ownerAddress: 'sam@gmail.com',
            attendees: [attendee('sam@gmail.com', { self: true }), attendee('dana@gmail.com')],
            insiders: new Set(['sam@gmail.com']),
            blocklist: [],
        });
        expect(outside.map((a) => a.address)).toEqual(['dana@gmail.com']);
    });
});

describe('nameFromDisplay (CAL-1)', () => {
    it('splits at the last space; one word is a first name; an address is no name', () => {
        expect(nameFromDisplay('Dana  Reyes', 'd@x.example')).toEqual({ nameFirst: 'Dana', nameLast: 'Reyes' });
        expect(nameFromDisplay('Mary Ann Lee', 'm@x.example')).toEqual({ nameFirst: 'Mary Ann', nameLast: 'Lee' });
        expect(nameFromDisplay('Dana', 'd@x.example')).toEqual({ nameFirst: 'Dana', nameLast: '' });
        expect(nameFromDisplay('d@x.example', 'd@x.example')).toEqual({ nameFirst: '', nameLast: '' });
        expect(nameFromDisplay('', 'd@x.example')).toEqual({ nameFirst: '', nameLast: '' });
    });
});

import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseSlotlineDelivery, slotlineDeliveryFor } from './slotline-booking';
import { signed } from './slotline-hook.service';

/** A delivery as Slotline (Cal.com) sends one: `{ triggerEvent, createdAt, payload }`. */
function delivery(triggerEvent: string, payload: Record<string, unknown> = {}) {
    return {
        triggerEvent,
        createdAt: '2026-10-15T10:00:00.000Z',
        payload: {
            uid: 'bk-1',
            iCalUID: 'bk-1@Slotline',
            title: 'Intro call between Sam and Dana',
            description: 'Private notes from the booker',
            startTime: '2026-10-20T13:00:00Z',
            endTime: '2026-10-20T13:30:00Z',
            status: 'ACCEPTED',
            location: 'integrations:daily',
            videoCallData: { url: 'https://video.example/room' },
            organizer: { email: 'Sam@Pinion.example', name: 'Sam Okafor', timeZone: 'Europe/London' },
            attendees: [
                { email: 'Dana@Acme.example', name: 'Dana Reyes', timeZone: 'America/New_York' },
                { email: 'lee@acme.example', name: 'lee@acme.example' },
            ],
            ...payload,
        },
    };
}

describe('parseSlotlineDelivery (CAL-2)', () => {
    it('reads a booking: its iCalendar UID as its identity, the organiser as the member, the booker and guests', () => {
        const parsed = parseSlotlineDelivery(delivery('BOOKING_CREATED'));
        if (parsed.kind !== 'booking') throw new Error(parsed.kind);
        expect(parsed).toMatchObject({ uid: 'bk-1', organizer: 'sam@pinion.example', replaces: null });
        expect(parsed.meeting).toMatchObject({
            providerEventId: 'bk-1@Slotline',
            identityKey: 'bk-1@Slotline',
            title: 'Intro call between Sam and Dana',
            status: 'confirmed',
            location: null,
            conferenceUrl: 'https://video.example/room',
            own: { responseStatus: 'accepted', isOrganizer: true },
        });
        expect(parsed.meeting.bookedAt.toISOString()).toBe('2026-10-15T10:00:00.000Z');
        expect(parsed.meeting.attendees.map((a) => [a.address, a.displayName, a.self])).toEqual([
            ['sam@pinion.example', 'Sam Okafor', true],
            ['dana@acme.example', 'Dana Reyes', false],
            // A guest added by address alone has no name.
            ['lee@acme.example', '', false],
        ]);
        expect(JSON.stringify(parsed)).not.toContain('Private notes');
    });

    it('a booking waiting for confirmation is tentative', () => {
        const parsed = parseSlotlineDelivery(delivery('BOOKING_REQUESTED', { status: 'PENDING' }));
        expect(parsed.kind === 'booking' && parsed.meeting.status).toBe('tentative');
    });

    it('a cancellation or rejection names the booking to call off', () => {
        expect(parseSlotlineDelivery(delivery('BOOKING_CANCELLED'))).toEqual({
            kind: 'cancel',
            uid: 'bk-1',
            organizer: 'sam@pinion.example',
            providerEventId: 'bk-1@Slotline',
        });
        expect(parseSlotlineDelivery(delivery('BOOKING_REJECTED')).kind).toBe('cancel');
    });

    it('a reschedule keeps the iCalendar UID, so it moves the meeting; without one it replaces the old booking', () => {
        const kept = parseSlotlineDelivery(delivery('BOOKING_RESCHEDULED', { uid: 'bk-2', rescheduleUid: 'bk-1' }));
        expect(kept.kind === 'booking' && [kept.meeting.identityKey, kept.replaces]).toEqual(['bk-1@Slotline', null]);
        const bare = parseSlotlineDelivery(
            delivery('BOOKING_RESCHEDULED', { uid: 'bk-2', rescheduleUid: 'bk-1', iCalUID: '' }),
        );
        expect(bare.kind === 'booking' && [bare.meeting.identityKey, bare.replaces]).toEqual([
            'slotline:bk-2',
            'slotline:bk-1',
        ]);
    });

    it('a ping is a ping; other triggers and malformed bookings are acknowledged and not read', () => {
        expect(parseSlotlineDelivery({ triggerEvent: 'PING' })).toEqual({ kind: 'ping' });
        expect(parseSlotlineDelivery(delivery('MEETING_ENDED')).kind).toBe('ignored');
        expect(parseSlotlineDelivery(delivery('BOOKING_CREATED', { organizer: {} })).kind).toBe('ignored');
        expect(parseSlotlineDelivery(delivery('BOOKING_CREATED', { startTime: 'soon' })).kind).toBe('ignored');
        expect(parseSlotlineDelivery('not json').kind).toBe('ignored');
    });
});

describe('signed (CAL-2)', () => {
    const body = Buffer.from('{"triggerEvent":"PING"}');
    const secret = 'a-long-enough-secret';
    const good = createHmac('sha256', secret).update(body).digest('hex');

    it('accepts the hex HMAC-SHA256 of the exact bytes, and nothing else', () => {
        expect(signed(body, good, secret)).toBe(true);
        expect(signed(body, good.toUpperCase(), secret)).toBe(true);
        expect(signed(Buffer.from('{"triggerEvent": "PING"}'), good, secret)).toBe(false);
        expect(signed(body, good, 'another-secret-entirely')).toBe(false);
        expect(signed(body, undefined, secret)).toBe(false);
        expect(signed(body, 'no-secret-provided', secret)).toBe(false);
    });
});

describe('a booking from Slotline’s admin route, as the delivery it would have been', () => {
    /** As `GET /api/admin/bookings/changes` lists a booking. */
    const listed = (fields: Record<string, unknown> = {}) => ({
        uid: 'bk-1',
        iCalUID: 'bk-1@Slotline',
        title: 'Intro call',
        status: 'ACCEPTED',
        startTime: '2026-10-20T13:00:00.000Z',
        endTime: '2026-10-20T13:30:00.000Z',
        location: 'integrations:google:meet',
        videoCallUrl: 'https://meet.example/abc',
        organizer: { email: 'sam@pinion.example', name: 'Sam Okafor' },
        attendees: [{ email: 'dana@acme.example', name: 'Dana Reyes' }],
        createdAt: '2026-10-15T10:00:00.000Z',
        updatedAt: null,
        rescheduled: false,
        rescheduleUid: null,
        ...fields,
    });
    const read = (fields: Record<string, unknown> = {}) => {
        const body = slotlineDeliveryFor(listed(fields));
        return body === null ? null : parseSlotlineDelivery(body);
    };

    it('an accepted booking is its creation, booked when it was created, with its video link', () => {
        const delivery = read();
        expect(delivery).toMatchObject({ kind: 'booking', uid: 'bk-1', rescheduled: false, replaces: null });
        if (delivery?.kind !== 'booking') throw new Error('not a booking');
        expect(delivery.meeting).toMatchObject({
            providerEventId: 'bk-1@Slotline',
            status: 'confirmed',
            conferenceUrl: 'https://meet.example/abc',
            bookedAt: new Date('2026-10-15T10:00:00.000Z'),
        });
        expect(delivery.meeting.attendees.map((a) => a.address)).toEqual(['sam@pinion.example', 'dana@acme.example']);
    });

    it('a pending booking is a request; a booking from a reschedule is the reschedule', () => {
        const pending = read({ status: 'PENDING' });
        expect(pending?.kind === 'booking' && pending.meeting.status).toBe('tentative');
        expect(read({ uid: 'bk-2', rescheduleUid: 'bk-1', iCalUID: null })).toMatchObject({
            kind: 'booking',
            rescheduled: true,
            replaces: 'slotline:bk-1',
        });
    });

    it('a cancelled or rejected booking calls the meeting off', () => {
        expect(read({ status: 'CANCELLED' })).toMatchObject({ kind: 'cancel', providerEventId: 'bk-1@Slotline' });
        expect(read({ status: 'REJECTED' })).toMatchObject({ kind: 'cancel' });
    });

    it('the booking a reschedule replaced is left: it shares the moved meeting’s UID, and no cancellation was sent', () => {
        expect(read({ status: 'CANCELLED', rescheduled: true })).toBeNull();
        expect(read({ status: 'AWAITING_HOST' })).toBeNull();
    });
});

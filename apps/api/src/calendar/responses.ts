import {
    CALENDAR_EVENT_STATUSES,
    CALENDAR_RESPONSE_STATUSES,
    MAIL_SYNC_STATUSES,
    MEETING_SOURCES,
} from '@bylinecrm/shared';
import { z } from 'zod';
import { dateTime, id, named, page } from '../openapi/responses';
import { memberSummaryView } from '../workspace/responses';

/** Calendar sync (CAL-1) as the API returns it. Never a meeting's description, never a token. */

const attendee = z.object({
    address: z.string(),
    displayName: z.string(),
    responseStatus: z.enum(CALENDAR_RESPONSE_STATUSES),
    isOrganizer: z.boolean(),
    personId: id.nullable().meta({ description: 'The person this attendee is, when they are one.' }),
    memberId: id.nullable().meta({ description: 'The workspace member this attendee is, when they are one.' }),
    leadCreated: z.boolean().meta({ description: 'Calendar sync created the person for this attendee.' }),
    leadSuggested: z.boolean().meta({
        description: 'Suggested to a member as a lead, waiting for them to add or dismiss (CAL-3).',
    }),
});

const memberCopy = z.object({
    memberId: id,
    responseStatus: z.enum(CALENDAR_RESPONSE_STATUSES).meta({ description: "The member's own answer." }),
    isOrganizer: z.boolean(),
});

export const meetingView = named(
    'Meeting',
    z.object({
        id,
        title: z.string(),
        startsAt: dateTime,
        endsAt: dateTime,
        allDay: z.boolean(),
        status: z.enum(CALENDAR_EVENT_STATUSES),
        location: z.string().nullable(),
        conferenceUrl: z.string().nullable().meta({ description: 'The Meet (or other video) link.' }),
        hostMemberId: id.meta({ description: 'The member the meeting counts for as booked.' }),
        bookedAt: dateTime.meta({ description: 'When the meeting was put in the calendar, or booked on Slotline.' }),
        bookedVia: z.enum(MEETING_SOURCES).meta({
            description:
                'Booked through the workspace’s Slotline booking site, or found in a member’s Google Calendar.',
        }),
        slotlineUrl: z.url().nullable().meta({ description: 'The booking on Slotline, when it is one.' }),
        cancelledAt: dateTime.nullable(),
        members: z.array(memberCopy).meta({
            description:
                "The members it is for — whose calendar holds it, or who organised the Slotline booking — once each, with each one's answer.",
        }),
        countsFor: z.array(id).meta({
            description:
                'The members the meeting counts towards: those it is for, one of whose customers — a person outside the workspace they own — is on it.',
        }),
        attendees: z.array(attendee),
    }),
);

export const meetingPage = named('MeetingPage', page(meetingView));

export const meetingKpiRow = named(
    'MeetingKpiRow',
    z.object({
        member: memberSummaryView,
        booked: z.number().int().meta({
            description:
                'Meetings the member booked in the period (a recurring meeting once): they host them. Every count but newLeads, awaitingCustomer and suggestedLeads takes only meetings with a person outside the workspace whom the member owns.',
        }),
        held: z.number().int().meta({
            description: 'Meetings in the period that have started, not cancelled and not declined by the member.',
        }),
        bookedViaSlotline: z.number().int().meta({
            description: 'Of those booked, the ones booked through the workspace’s Slotline booking site (CAL-2).',
        }),
        upcoming: z
            .number()
            .int()
            .meta({ description: 'Meetings in the period still to come, not cancelled or declined.' }),
        cancelled: z
            .number()
            .int()
            .meta({ description: 'Meetings the member hosts that were called off in the period.' }),
        peopleMet: z
            .number()
            .int()
            .meta({ description: 'Different people outside the workspace in the held meetings.' }),
        awaitingCustomer: z.number().int().meta({
            description:
                'Meetings in the period the member attended that do not count: none of the people outside is a person they own yet.',
        }),
        suggestedLeads: z.number().int().meta({
            description: 'Attendees suggested to the member as leads, waiting for them to add or dismiss.',
        }),
        newLeads: z
            .number()
            .int()
            .meta({ description: 'People created from the attendees of their meetings in the period.' }),
    }),
);

export const meetingKpis = named(
    'MeetingKpis',
    z.object({
        from: dateTime,
        to: dateTime,
        rows: z.array(meetingKpiRow).meta({
            description: 'One row per member the caller may see: every member for an admin, else the caller alone.',
        }),
    }),
);

const syncError = z.object({ code: z.string(), message: z.string(), at: dateTime });

export const calendarSyncView = named(
    'CalendarSync',
    z.object({
        mailboxId: id,
        granted: z.boolean().meta({
            description: "The mailbox's Google connection includes the calendar. False: connect it again and allow it.",
        }),
        status: z.enum(MAIL_SYNC_STATUSES),
        lastSyncedAt: dateTime.nullable(),
        windowReadAt: dateTime.nullable().meta({ description: 'The last full read of the window.' }),
        lastError: syncError.nullable().meta({ description: 'Why the last run stopped or was skipped.' }),
    }),
);

export const calendarSyncTriggered = named(
    'CalendarSyncTriggered',
    z.object({
        sync: calendarSyncView,
        queued: z.boolean().meta({ description: 'False when a run for this calendar is already queued or running.' }),
    }),
);

const suggestedMeeting = z.object({ id, title: z.string(), startsAt: dateTime });

export const leadSuggestionView = named(
    'LeadSuggestion',
    z.object({
        memberId: id.meta({ description: 'The member the lead would be — and whose meetings would count.' }),
        address: z.string(),
        displayName: z.string(),
        meetings: z
            .array(suggestedMeeting)
            .meta({ description: 'The meetings they were on, latest first (up to five).' }),
        suggestedAt: dateTime,
    }),
);

export const leadSuggestionAccepted = named(
    'LeadSuggestionAccepted',
    z.object({ personId: id.meta({ description: 'The person the member now owns.' }) }),
);

export type LeadSuggestionView = z.output<typeof leadSuggestionView>;
export type LeadSuggestionAccepted = z.output<typeof leadSuggestionAccepted>;
export type MeetingView = z.output<typeof meetingView>;
export type MeetingKpiRow = z.output<typeof meetingKpiRow>;
export type MeetingKpis = z.output<typeof meetingKpis>;
export type CalendarSyncView = z.output<typeof calendarSyncView>;
export type CalendarSyncTriggered = z.output<typeof calendarSyncTriggered>;

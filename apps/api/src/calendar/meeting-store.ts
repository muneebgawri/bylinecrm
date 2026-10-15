import { Injectable } from '@nestjs/common';
import type { CalendarEventStatus, DomainEvent, MeetingSummary, RecordTarget } from '@bylinecrm/shared';
import type { MeetingSource, Prisma } from '@prisma/client';
import { isFreeMailDomain } from '../enrichment/email-domain';
import { DomainEvents } from '../events/domain-events.service';
import { UniqueConflict } from '../infra/errors/api-errors';
import { uniqueViolation } from '../infra/prisma-errors';
import { RlsPrismaService, type WorkspaceClient } from '../infra/rls-prisma.service';
import { WorkspaceContext, type WorkspaceRunContext } from '../infra/workspace-context';
import { entriesFor } from '../mail-sync/blocklist-rule';
import { membersByAddress, personsByAddress, recordTargetsForPeople } from '../mail-sync/matching';
import { PeopleService } from '../records/people.service';
import { CALENDAR_MAX_ATTENDEES, CALENDAR_STORE_ATTEMPTS } from './calendar.constants';
import { domainOf, nameFromDisplay, outsideAttendees } from './outside';
import type { ParsedAttendee, ParsedMeeting } from './parse-event';

type EventRow = Prisma.CalendarEventGetPayload<object>;
type CopyRow = Prisma.CalendarEventCopyGetPayload<object>;

/**
 * Who is inside the workspace, for a member: every member's sign-in address and every connected mailbox's (plus
 * the member's own address on the invitation), and the blocklist entries that apply to the member's own mail
 * (`entriesFor`, as for their personal mailbox). One read, used by every source's copies alike.
 */
export async function insidersFor(
    tx: WorkspaceClient,
    member: { memberId: string; address: string },
): Promise<{ insiders: Set<string>; blocklist: string[] }> {
    const [members, mailboxes, entries] = await Promise.all([
        tx.workspaceMember.findMany({ select: { user: { select: { email: true } } } }),
        tx.mailbox.findMany({ select: { email: true } }),
        tx.blocklistEntry.findMany({
            where: { OR: [{ memberId: null }, { memberId: member.memberId }] },
            select: { value: true, memberId: true },
        }),
    ]);
    return {
        insiders: new Set([
            member.address,
            ...members.map((m) => m.user.email.toLowerCase()),
            ...mailboxes.map((m) => m.email.toLowerCase()),
        ]),
        blocklist: entriesFor({ email: member.address, ownerMemberId: member.memberId, purpose: 'personal' }, entries),
    };
}

/** The scope a write runs in: the workspace, no member, and the sync as the actor. */
export interface WriteScope {
    workspaceId: string;
    context: WorkspaceRunContext;
}

/**
 * Which copy of a meeting a call is about (CAL-1, CAL-2): a Google copy by its mailbox and Google's id, a
 * Slotline copy by the booking's iCalendar UID. Enough to find it and call it off — no member needed, so a
 * cancellation still lands after its organiser has left.
 */
export interface CopyKey extends WriteScope {
    source: MeetingSource;
    /** The mailbox a Google copy is read through; null for a Slotline copy. */
    mailboxId: string | null;
}

/**
 * Whose copy of a meeting a write is: a member's Google Calendar, read through their mailbox, or a Slotline
 * booking they organised. Everything the rules need to know about where it came from.
 */
export interface CopyOrigin extends CopyKey {
    /** The member the copy is — the calendar's owner, or the booking's organiser. */
    memberId: string;
    /** The member's own address on the invitation (never an outside attendee). */
    ownerAddress: string;
    /** Members' sign-in addresses and the workspace's mailboxes, lower case. */
    insiders: ReadonlySet<string>;
    /** The blocklist entries that apply to the member's mail. */
    blocklist: readonly string[];
    /** `source` of the people created from outside attendees (FR-CRMS-11). */
    leadSource: string;
}

/** What a Slotline booking adds to its copy: the booking's uid (for a link), and whether it may reopen a meeting. */
export interface BookingFacts {
    slotlineUid: string;
    /**
     * A reschedule may bring a cancelled booking back; a creation never does — a late or replayed
     * `BOOKING_CREATED` arriving after the cancellation must not undo it.
     */
    mayReopen: boolean;
}

export type WriteOutcome = { outcome: 'stored' | 'updated' | 'unchanged' | 'passed_over'; leads: number };

/**
 * The one writer of meetings (CAL-1), whichever source a copy comes from — as mail sync has one writer for
 * every mailbox. What it keeps, the leads it makes, and the events it announces are the same for a Google
 * Calendar event and a Slotline booking; the two only differ in how a copy is keyed and in who may call a
 * meeting off or back on (`cancel`, `reopens`). Rules (see `docs/design-notes/CAL-1.md`, `CAL-2.md`):
 *
 * - **Kept**: a meeting with at least one outside attendee (`outsideAttendees`), at most
 *   `CALENDAR_MAX_ATTENDEES` on it, that the member has not declined. Once per workspace (`identity_key`);
 *   each source's copy records the member's answer.
 * - **Leads**: each outside attendee who is no one in the CRM becomes a person the member owns (the origin's
 *   `leadSource`, their company by domain when the workspace has one); a person nobody owns is given to the
 *   member. A person someone deleted stays deleted.
 * - **Events**: a meeting first stored is announced as `meeting.booked` on the records its outside people
 *   concern; one called off, once, as `meeting.cancelled`.
 */
@Injectable()
export class MeetingStore {
    constructor(
        private readonly rls: RlsPrismaService,
        private readonly scope: WorkspaceContext,
        private readonly events: DomainEvents,
        private readonly people: PeopleService,
    ) {}

    /**
     * One write in its own transaction, in the origin's scope (the record services read the workspace from
     * it). Two members' runs — or a calendar read and a Slotline delivery — may store the first copy of one
     * meeting (or the same new lead) at once: the loser of the race finds the winner's rows on its second attempt.
     */
    async store<T>(origin: WriteScope, write: (tx: WorkspaceClient) => Promise<T>): Promise<T> {
        for (let attempt = 1; ; attempt += 1) {
            try {
                return await this.scope.run(origin.context, () => this.rls.withWorkspace(origin.workspaceId, write));
            } catch (error) {
                if (!(uniqueViolation(error) || error instanceof UniqueConflict)) throw error;
                if (attempt >= CALENDAR_STORE_ATTEMPTS) throw error;
            }
        }
    }

    /**
     * Stores the origin's copy of a meeting (in the caller's transaction). The first copy of a meeting creates
     * and announces it; a later copy — another member's calendar, or the Slotline booking of a meeting already
     * read from Google — adds itself and brings the meeting's details up to date.
     */
    async writeMeeting(
        tx: WorkspaceClient,
        origin: CopyOrigin,
        parsed: ParsedMeeting,
        booking?: BookingFacts,
    ): Promise<WriteOutcome> {
        const owner = origin.memberId;
        const copy = await this.findCopy(tx, origin, parsed.providerEventId);
        const known =
            (copy && (await tx.calendarEvent.findUnique({ where: { id: copy.eventId } }))) ??
            (await tx.calendarEvent.findUnique({
                where: {
                    workspaceId_identityKey: { workspaceId: origin.workspaceId, identityKey: parsed.identityKey },
                },
            }));
        const outside = outsideAttendees({
            ownerAddress: origin.ownerAddress,
            attendees: parsed.attendees,
            insiders: origin.insiders,
            blocklist: origin.blocklist,
        });
        const counts =
            outside.length > 0 &&
            parsed.attendees.length <= CALENDAR_MAX_ATTENDEES &&
            parsed.own.responseStatus !== 'declined';
        // Nothing stored and nothing to store: someone's own event, a colleagues-only meeting, a webinar.
        if (!known && !counts) return { outcome: 'passed_over', leads: 0 };

        const details = {
            title: parsed.title,
            location: parsed.location,
            conferenceUrl: parsed.conferenceUrl,
            startsAt: parsed.startsAt,
            endsAt: parsed.endsAt,
            allDay: parsed.allDay,
            organizerAddress: parsed.organizerAddress,
            ...(booking ? { bookedVia: 'slotline' as const, slotlineUid: booking.slotlineUid } : {}),
        };
        let event: EventRow;
        let changed = false;
        if (!known) {
            event = await tx.calendarEvent.create({
                data: {
                    ...details,
                    workspaceId: origin.workspaceId,
                    identityKey: parsed.identityKey,
                    icalUid: parsed.icalUid,
                    status: parsed.status,
                    hostMemberId: owner,
                    bookedAt: parsed.bookedAt,
                },
            });
        } else {
            const reopened = known.status === 'cancelled' && reopens(known, origin, parsed, booking);
            const status: CalendarEventStatus = known.status === 'cancelled' && !reopened ? 'cancelled' : parsed.status;
            const data = {
                ...details,
                status,
                ...(reopened ? { cancelledAt: null } : {}),
                // The organiser's own copy is where a meeting is booked: it counts for them.
                ...(parsed.own.isOrganizer && known.hostMemberId !== owner ? { hostMemberId: owner } : {}),
            };
            changed = differs(known, data);
            event = changed ? await tx.calendarEvent.update({ where: { id: known.id }, data }) : known;
        }

        if (!copy) {
            await tx.calendarEventCopy.create({
                data: {
                    workspaceId: origin.workspaceId,
                    eventId: event.id,
                    source: origin.source,
                    mailboxId: origin.mailboxId,
                    memberId: owner,
                    providerEventId: parsed.providerEventId,
                    responseStatus: parsed.own.responseStatus,
                    isOrganizer: parsed.own.isOrganizer,
                },
            });
        } else if (
            copy.responseStatus !== parsed.own.responseStatus ||
            copy.isOrganizer !== parsed.own.isOrganizer ||
            copy.eventId !== event.id ||
            copy.memberId !== owner
        ) {
            changed = true;
            await tx.calendarEventCopy.update({
                where: { id: copy.id },
                data: {
                    eventId: event.id,
                    // A booking reassigned to another organiser, or a mailbox connected again by another member.
                    memberId: owner,
                    responseStatus: parsed.own.responseStatus,
                    isOrganizer: parsed.own.isOrganizer,
                },
            });
        }

        const recorded: DomainEvent[] = [];
        const people = await personsByAddress(
            tx,
            parsed.attendees.map((a) => a.address),
        );
        // Leads come only from meetings that count: an outside attendee who is no one yet becomes a person
        // the member owns; one who is a person nobody owns is given to them.
        const leadsFor = new Set<string>();
        if (counts) {
            for (const attendee of outside) {
                if (people.has(attendee.address)) continue;
                const created = await this.createLead(tx, origin, attendee);
                if (!created) continue;
                people.set(attendee.address, created.id);
                leadsFor.add(attendee.address);
                recorded.push(created.event);
            }
            const outsideIds = outside.map((a) => people.get(a.address)).filter((id): id is string => !!id);
            const unowned = await tx.person.findMany({
                where: { id: { in: outsideIds }, ownerId: null, deletedAt: null },
                select: { id: true },
                orderBy: { id: 'asc' },
            });
            for (const person of unowned) {
                const updated = await this.people.updateIn(tx, origin.context, person.id, { ownerId: owner });
                if (updated.event) recorded.push(updated.event);
            }
        }

        const participants = {
            eventId: event.id,
            workspaceId: origin.workspaceId,
            // Only the organiser's copy is sure to list every guest: a guest's calendar may hide the others.
            mayPrune: parsed.own.isOrganizer,
        };
        if (await this.reconcileParticipants(tx, participants, parsed.attendees, people, leadsFor, owner))
            changed = true;

        if (!known) {
            const outsideIds = outside.map((a) => people.get(a.address)).filter((id): id is string => !!id);
            recorded.push(await this.meetingEvent(tx, 'meeting.booked', event, outsideIds, event.bookedAt));
        }
        await this.events.recordAll(tx, recorded);
        return { outcome: !copy ? 'stored' : changed ? 'updated' : 'unchanged', leads: leadsFor.size };
    }

    /**
     * The origin's copy was called off. A Google copy (the organiser cancelled it, or the member took it out
     * of their calendar) becomes a "no", and the meeting is cancelled when no copy still holds it with anything
     * but a "no". A Slotline cancellation (`authoritative`, with the meeting's identity) is the booking system's
     * word: the meeting is cancelled at once, whatever the calendars still show — also one only a calendar held
     * (booked before the hook was set up). Announced once. True if anything changed.
     */
    async cancel(
        tx: WorkspaceClient,
        origin: CopyKey,
        providerEventId: string,
        authoritative?: { identityKey: string },
    ): Promise<boolean> {
        const copy = await this.findCopy(tx, origin, providerEventId);
        const event = copy
            ? await tx.calendarEvent.findUniqueOrThrow({ where: { id: copy.eventId } })
            : authoritative
              ? await tx.calendarEvent.findUnique({
                    where: {
                        workspaceId_identityKey: {
                            workspaceId: origin.workspaceId,
                            identityKey: authoritative.identityKey,
                        },
                    },
                })
              : null;
        if (!event) return false;
        if ((!copy || copy.responseStatus === 'declined') && event.status === 'cancelled') return false;
        if (copy && copy.responseStatus !== 'declined') {
            await tx.calendarEventCopy.update({ where: { id: copy.id }, data: { responseStatus: 'declined' } });
        }
        if (event.status === 'cancelled') return true;
        if (!authoritative) {
            const live = await tx.calendarEventCopy.count({
                where: { eventId: event.id, responseStatus: { not: 'declined' } },
            });
            if (live > 0) return true;
        }
        const cancelledAt = new Date();
        const after = await tx.calendarEvent.update({
            where: { id: event.id },
            data: { status: 'cancelled', cancelledAt },
        });
        const people = await tx.calendarEventParticipant.findMany({
            where: { eventId: event.id, memberId: null, personId: { not: null } },
            select: { personId: true },
        });
        await this.events.record(
            tx,
            await this.meetingEvent(
                tx,
                'meeting.cancelled',
                after,
                people.map((p) => p.personId!),
                cancelledAt,
            ),
        );
        return true;
    }

    /** The origin's copy with this provider id: per mailbox for Google, per workspace for Slotline. */
    private findCopy(tx: WorkspaceClient, origin: CopyKey, providerEventId: string): Promise<CopyRow | null> {
        if (origin.source === 'google_calendar') {
            return tx.calendarEventCopy.findUnique({
                where: { mailboxId_providerEventId: { mailboxId: origin.mailboxId!, providerEventId } },
            });
        }
        return tx.calendarEventCopy.findFirst({ where: { source: 'slotline', providerEventId } });
    }

    /**
     * A new person for an outside attendee, owned by the member; nothing when a deleted person holds the
     * address (someone took them out of the CRM; a meeting does not bring them back).
     */
    private async createLead(
        tx: WorkspaceClient,
        origin: CopyOrigin,
        attendee: ParsedAttendee,
    ): Promise<{ id: string; event: DomainEvent } | null> {
        const deleted = await tx.person.findFirst({ where: { emailPrimary: attendee.address }, select: { id: true } });
        if (deleted) return null;
        const domain = domainOf(attendee.address);
        const company =
            domain && !isFreeMailDomain(domain)
                ? await tx.company.findFirst({
                      where: { domain, deletedAt: null },
                      select: { id: true },
                      orderBy: { createdAt: 'asc' },
                  })
                : null;
        const { row, event } = await this.people.createIn(tx, origin.context, {
            ...nameFromDisplay(attendee.displayName, attendee.address),
            emails: { primary: attendee.address, additional: [] },
            source: origin.leadSource,
            ownerId: origin.memberId,
            companyId: company?.id ?? null,
        });
        return { id: row.id, event };
    }

    /**
     * Brings the meeting's attendee rows in line with the invitation: new ones added, answers and matches
     * followed. Those taken off are removed only as the organiser's copy shows it (a guest's calendar may hide
     * the other guests), and never a row that brought in a lead — the member's KPI keeps it. True if any changed.
     */
    private async reconcileParticipants(
        tx: WorkspaceClient,
        { eventId, workspaceId, mayPrune }: { eventId: string; workspaceId: string; mayPrune: boolean },
        attendees: readonly ParsedAttendee[],
        people: ReadonlyMap<string, string>,
        leadsFor: ReadonlySet<string>,
        owner: string,
    ): Promise<boolean> {
        const [existing, members] = await Promise.all([
            tx.calendarEventParticipant.findMany({ where: { eventId } }),
            membersByAddress(
                tx,
                attendees.map((a) => a.address),
            ),
        ]);
        const byAddress = new Map(existing.map((p) => [p.address, p]));
        let changed = false;
        for (const attendee of attendees) {
            const row = byAddress.get(attendee.address);
            const data = {
                displayName: attendee.displayName,
                responseStatus: attendee.responseStatus,
                isOrganizer: attendee.isOrganizer,
                personId: people.get(attendee.address) ?? null,
                memberId: members.get(attendee.address) ?? null,
            };
            if (!row) {
                changed = true;
                await tx.calendarEventParticipant.create({
                    data: {
                        ...data,
                        workspaceId,
                        eventId,
                        address: attendee.address,
                        leadCreatedForMemberId: leadsFor.has(attendee.address) ? owner : null,
                    },
                });
            } else if (
                row.displayName !== data.displayName ||
                row.responseStatus !== data.responseStatus ||
                row.isOrganizer !== data.isOrganizer ||
                row.personId !== data.personId ||
                row.memberId !== data.memberId ||
                (leadsFor.has(attendee.address) && row.leadCreatedForMemberId === null)
            ) {
                changed = true;
                await tx.calendarEventParticipant.update({
                    where: { id: row.id },
                    data: { ...data, ...(leadsFor.has(attendee.address) ? { leadCreatedForMemberId: owner } : {}) },
                });
            }
        }
        const present = new Set(attendees.map((a) => a.address));
        const gone = mayPrune
            ? existing.filter((p) => !present.has(p.address) && p.leadCreatedForMemberId === null).map((p) => p.id)
            : [];
        if (gone.length > 0) {
            changed = true;
            await tx.calendarEventParticipant.deleteMany({ where: { id: { in: gone } } });
        }
        return changed;
    }

    /** A `meeting.*` event on the records the meeting's outside people concern. */
    private async meetingEvent(
        tx: WorkspaceClient,
        type: 'meeting.booked' | 'meeting.cancelled',
        event: EventRow,
        personIds: readonly string[],
        at: Date,
    ): Promise<DomainEvent> {
        const targets = await recordTargetsForPeople(tx, personIds);
        const related: RecordTarget[] = targets.filter((t) => t.type !== 'opportunity');
        return {
            type,
            object: 'meeting',
            workspaceId: event.workspaceId,
            actor: { kind: 'sync', id: null },
            occurredAt: at.toISOString(),
            recordId: event.id,
            targets,
            related,
            meeting: meetingSummary(event),
        };
    }
}

/**
 * Whether a copy brings a cancelled meeting back: one the member has not declined. A Slotline delivery reopens
 * only as a reschedule (`mayReopen`). A meeting booked through Slotline is reopened only by Slotline: it is the
 * system of record for its bookings, and the Google event it wrote may linger in a calendar after a cancellation.
 */
function reopens(known: EventRow, origin: CopyOrigin, parsed: ParsedMeeting, booking?: BookingFacts): boolean {
    if (parsed.own.responseStatus === 'declined') return false;
    if (origin.source === 'slotline') return booking?.mayReopen === true;
    return known.bookedVia !== 'slotline';
}

/** A meeting as its events describe it. */
export function meetingSummary(event: EventRow): MeetingSummary {
    return {
        meetingId: event.id,
        title: event.title,
        startsAt: event.startsAt.toISOString(),
        endsAt: event.endsAt.toISOString(),
        allDay: event.allDay,
        conferenceUrl: event.conferenceUrl,
        hostMemberId: event.hostMemberId,
        bookedAt: event.bookedAt.toISOString(),
        bookedVia: event.bookedVia,
    };
}

/** Whether writing `data` would change the stored meeting. */
function differs(row: EventRow, data: Partial<EventRow>): boolean {
    return (Object.keys(data) as (keyof EventRow)[]).some((key) => {
        const before = row[key];
        const after = data[key];
        if (before instanceof Date && after instanceof Date) return before.getTime() !== after.getTime();
        return before !== after;
    });
}

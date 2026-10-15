import { Inject, Injectable, Logger } from '@nestjs/common';
import {
    calendarGranted,
    GOOGLE_CALENDAR_SCOPE,
    type CalendarEventStatus,
    type DomainEvent,
    type MailSyncStatus,
    type MeetingSummary,
    type RecordTarget,
} from '@bylinecrm/shared';
import { Prisma } from '@prisma/client';
import { isFreeMailDomain } from '../enrichment/email-domain';
import { DomainEvents } from '../events/domain-events.service';
import { UniqueConflict } from '../infra/errors/api-errors';
import { uniqueViolation } from '../infra/prisma-errors';
import { RlsPrismaService, type WorkspaceClient } from '../infra/rls-prisma.service';
import { WorkspaceContext, type WorkspaceRunContext } from '../infra/workspace-context';
import { MailboxTokens, MailboxUnavailable } from '../mail-accounts/mailbox-tokens.service';
import { entriesFor } from '../mail-sync/blocklist-rule';
import { membersByAddress, personsByAddress, recordTargetsForPeople } from '../mail-sync/matching';
import { gmailRetryDelayMs, type RetryOptions } from '../mail-sync/retry';
import { PeopleService } from '../records/people.service';
import {
    CALENDAR_HORIZON_DAYS,
    CALENDAR_INITIAL_DAYS,
    CALENDAR_LEAD_SOURCE,
    CALENDAR_MAX_ATTENDEES,
    CALENDAR_RECENT_DAYS,
    CALENDAR_RETRY_ATTEMPTS,
    CALENDAR_STORE_ATTEMPTS,
    CALENDAR_UPDATED_MARGIN_MS,
    CALENDAR_WINDOW_READ_EVERY_MS,
} from './calendar.constants';
import { GOOGLE_CALENDAR_PORT, GoogleCalendarError, type GoogleCalendarPort } from './google-calendar.port';
import { domainOf, nameFromDisplay, outsideAttendees } from './outside';
import { parseGoogleEvent, type ParsedAttendee, type ParsedMeeting } from './parse-event';

type MailboxRow = Prisma.MailboxGetPayload<object>;
type EventRow = Prisma.CalendarEventGetPayload<object>;

const DAY_MS = 24 * 60 * 60 * 1000;

/** How a run went: what it stored, and what it passed over. */
export interface CalendarRunResult {
    /** `window`: the whole window was read; `changes`: only what changed since the last run; `skipped`: the calendar could not be read. */
    mode: 'window' | 'changes' | 'skipped';
    /** Meetings stored from this calendar for the first time (a meeting another calendar stored first gains this one's copy). */
    stored: number;
    /** Meetings already stored that were brought up to date. */
    updated: number;
    /** Meetings Google reports called off in this calendar. */
    cancelled: number;
    /** Events that are not meetings with someone outside the workspace (or too big, or declined). */
    passedOver: number;
    /** People created from outside attendees: new leads, owned by the calendar's owner. */
    leadsCreated: number;
}

/** Why the last run stopped, as kept on the sync state. Never a token or a raw Google body. */
interface SyncErrorRecord {
    code: string;
    message: string;
    at: string;
}

/** What a run knows before it reads anything: the mailbox, who is inside the workspace, the blocklist. */
interface Run {
    mailbox: MailboxRow;
    /** The scope every write runs in: the workspace, no member, and the calendar's sync as the actor. */
    context: WorkspaceRunContext;
    insiders: Set<string>;
    blocklist: string[];
    retry: RetryOptions;
}

type WriteOutcome = { outcome: 'stored' | 'updated' | 'unchanged' | 'passed_over'; leads: number };

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Calendar sync (CAL-1): reads a personal mailbox's Google Calendar through the mailbox's own grant and
 * keeps the meetings it holds with people outside the workspace.
 *
 * - **What is read.** The first run reads the last `CALENDAR_INITIAL_DAYS` and the next
 *   `CALENDAR_HORIZON_DAYS`; later runs read only what changed since the run before, and once a day the
 *   whole window again (so occurrences of a recurring meeting are found as they come within the horizon).
 * - **What is kept.** A meeting with at least one outside attendee (`outsideAttendees`), at most
 *   `CALENDAR_MAX_ATTENDEES` on the invitation, that the calendar's owner has not declined. Once per
 *   workspace however many members' calendars hold it; each calendar's copy records its member's answer.
 * - **Leads.** Each outside attendee who is no one in the CRM becomes a person owned by the calendar's
 *   owner (source `Google Calendar`, their company when the workspace has one at their domain); one who
 *   is a person nobody owns is given to the calendar's owner. A person someone deleted is left deleted.
 * - **Events.** A meeting first stored is announced as `meeting.booked` on the records its outside
 *   attendees concern (the timeline, webhooks, the `meeting.booked` stage rule); one called off in every
 *   calendar that held it, as `meeting.cancelled`.
 *
 * Runs outside any request (a worker job): the workspace is passed explicitly and no owner scope applies.
 */
@Injectable()
export class CalendarSyncService {
    private readonly logger = new Logger(CalendarSyncService.name);

    constructor(
        private readonly rls: RlsPrismaService,
        private readonly scope: WorkspaceContext,
        private readonly tokens: MailboxTokens,
        private readonly events: DomainEvents,
        private readonly people: PeopleService,
        @Inject(GOOGLE_CALENDAR_PORT) private readonly calendar: GoogleCalendarPort,
    ) {}

    /** One run for one mailbox's calendar. Throws on a failure worth retrying; records every outcome. */
    async syncCalendar(workspaceId: string, mailboxId: string, retry: RetryOptions = {}): Promise<CalendarRunResult> {
        const totals: CalendarRunResult = {
            mode: 'skipped',
            stored: 0,
            updated: 0,
            cancelled: 0,
            passedOver: 0,
            leadsCreated: 0,
        };
        const mailbox = await this.rls.withWorkspace(workspaceId, (tx) =>
            tx.mailbox.findUnique({ where: { id: mailboxId } }),
        );
        // A pool mailbox is the workspace's outreach, not anyone's calendar.
        if (!mailbox || mailbox.purpose !== 'personal') return totals;
        const unusable = await this.unusable(mailbox);
        if (unusable) {
            await this.recordStopped(mailbox, unusable);
            return totals;
        }

        const state = await this.rls.withWorkspace(workspaceId, (tx) =>
            tx.calendarSyncState.upsert({
                where: { mailboxId },
                create: { mailboxId, workspaceId, status: 'syncing' },
                update: { status: 'syncing' },
            }),
        );
        const startedAt = new Date();
        const whole =
            !state.windowReadAt ||
            !state.lastSyncedAt ||
            startedAt.getTime() - state.windowReadAt.getTime() >= CALENDAR_WINDOW_READ_EVERY_MS;
        const backDays = state.windowReadAt ? CALENDAR_RECENT_DAYS : CALENDAR_INITIAL_DAYS;
        const window = {
            timeMin: new Date(startedAt.getTime() - backDays * DAY_MS),
            timeMax: new Date(startedAt.getTime() + CALENDAR_HORIZON_DAYS * DAY_MS),
            ...(whole ? {} : { updatedMin: new Date(state.lastSyncedAt!.getTime() - CALENDAR_UPDATED_MARGIN_MS) }),
        };
        totals.mode = whole ? 'window' : 'changes';

        try {
            const run = await this.prepare(mailbox, retry);
            let pageToken: string | undefined;
            do {
                const page = await this.request(run, (token) =>
                    this.calendar.listEvents(token, { ...window, ...(pageToken ? { pageToken } : {}) }),
                );
                for (const raw of page.items) {
                    const parsed = parseGoogleEvent(raw, mailbox.id);
                    if (parsed.kind === 'skipped') {
                        totals.passedOver += 1;
                    } else if (parsed.kind === 'cancelled') {
                        if (await this.store(run, (tx) => this.writeCancelled(tx, run, parsed.providerEventId)))
                            totals.cancelled += 1;
                    } else {
                        const written = await this.store(run, (tx) => this.writeMeeting(tx, run, parsed));
                        totals.leadsCreated += written.leads;
                        if (written.outcome === 'stored') totals.stored += 1;
                        else if (written.outcome === 'updated') totals.updated += 1;
                        else if (written.outcome === 'passed_over') totals.passedOver += 1;
                    }
                }
                pageToken = page.nextPageToken ?? undefined;
            } while (pageToken);

            await this.rls.withWorkspace(workspaceId, (tx) =>
                tx.calendarSyncState.update({
                    where: { mailboxId },
                    data: {
                        status: 'idle',
                        // The run's start: the next changes-only read reaches back to it (less a margin).
                        lastSyncedAt: startedAt,
                        lastError: Prisma.DbNull,
                        ...(whole ? { windowReadAt: startedAt } : {}),
                    },
                }),
            );
            return totals;
        } catch (error) {
            if (error instanceof MailboxUnavailable) {
                await this.recordStopped(mailbox, unavailableError(error.mailboxStatus));
                return { ...totals, mode: 'skipped' };
            }
            if (error instanceof GoogleCalendarError && error.scopeMissing) {
                // The person withdrew calendar access in their Google account. The mailbox stops claiming
                // it, so the tick stops reading a calendar it may not, and the page offers to connect it.
                await this.forgetCalendarScope(mailbox);
                await this.recordStopped(mailbox, notGrantedError());
                return { ...totals, mode: 'skipped' };
            }
            if (error instanceof GoogleCalendarError && error.apiDisabled) {
                await this.recordStopped(mailbox, {
                    code: 'calendar_api_disabled',
                    message:
                        'the Google Calendar API is not turned on in the workspace’s Google Cloud project; an admin turns it on (Settings → Google)',
                    at: new Date().toISOString(),
                });
                return { ...totals, mode: 'skipped' };
            }
            await this.recordStopped(mailbox, runError(error));
            throw error;
        }
    }

    // ── Before a run ─────────────────────────────────────────────────────────────────────────

    /** Why the calendar cannot be read now, or nothing when it can. */
    private async unusable(mailbox: MailboxRow): Promise<SyncErrorRecord | null> {
        if (mailbox.status !== 'connected') return unavailableError(mailbox.status);
        if (!calendarGranted(mailbox.grantedScopes)) return notGrantedError();
        const owner = await this.rls.withWorkspace(mailbox.workspaceId, (tx) =>
            tx.workspaceMember.findUnique({ where: { id: mailbox.ownerMemberId }, select: { leftAt: true } }),
        );
        if (!owner || owner.leftAt) {
            return {
                code: 'member_left',
                message: 'the calendar’s owner has left the workspace; calendar sync stopped',
                at: new Date().toISOString(),
            };
        }
        return null;
    }

    /** Everyone inside the workspace (members' sign-in addresses, its mailboxes) and the blocklist that applies. */
    private async prepare(mailbox: MailboxRow, retry: RetryOptions): Promise<Run> {
        return this.rls.withWorkspace(mailbox.workspaceId, async (tx) => {
            const [members, mailboxes, entries] = await Promise.all([
                tx.workspaceMember.findMany({ select: { user: { select: { email: true } } } }),
                tx.mailbox.findMany({ select: { email: true } }),
                tx.blocklistEntry.findMany({
                    where: { OR: [{ memberId: null }, { memberId: mailbox.ownerMemberId }] },
                    select: { value: true, memberId: true },
                }),
            ]);
            const insiders = new Set([
                ...members.map((m) => m.user.email.toLowerCase()),
                ...mailboxes.map((m) => m.email.toLowerCase()),
            ]);
            const context: WorkspaceRunContext = {
                workspaceId: mailbox.workspaceId,
                capabilities: new Set(),
                actor: { kind: 'sync', id: mailbox.id },
            };
            return { mailbox, context, insiders, blocklist: entriesFor(mailbox, entries), retry };
        });
    }

    // ── Writing ──────────────────────────────────────────────────────────────────────────────

    /**
     * Stores one meeting from this calendar (in the caller's transaction), as the module comment says.
     * The meeting itself is written once per workspace: the first calendar to hold it creates it and
     * announces it; a later calendar adds its copy and brings the meeting's details up to date.
     */
    private async writeMeeting(tx: WorkspaceClient, run: Run, parsed: ParsedMeeting): Promise<WriteOutcome> {
        const { mailbox } = run;
        const owner = mailbox.ownerMemberId;
        const copy = await tx.calendarEventCopy.findUnique({
            where: { mailboxId_providerEventId: { mailboxId: mailbox.id, providerEventId: parsed.providerEventId } },
        });
        const known =
            (copy && (await tx.calendarEvent.findUnique({ where: { id: copy.eventId } }))) ??
            (await tx.calendarEvent.findUnique({
                where: {
                    workspaceId_identityKey: { workspaceId: mailbox.workspaceId, identityKey: parsed.identityKey },
                },
            }));
        const outside = outsideAttendees({
            ownerAddress: mailbox.email,
            attendees: parsed.attendees,
            insiders: run.insiders,
            blocklist: run.blocklist,
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
        };
        let event: EventRow;
        let changed = false;
        if (!known) {
            event = await tx.calendarEvent.create({
                data: {
                    ...details,
                    workspaceId: mailbox.workspaceId,
                    identityKey: parsed.identityKey,
                    icalUid: parsed.icalUid,
                    status: parsed.status,
                    hostMemberId: owner,
                    bookedAt: parsed.bookedAt,
                },
            });
        } else {
            // A meeting called off and now back in a calendar that has not declined it is on again.
            const reopened = known.status === 'cancelled' && parsed.own.responseStatus !== 'declined';
            const status: CalendarEventStatus = known.status === 'cancelled' && !reopened ? 'cancelled' : parsed.status;
            const data = {
                ...details,
                status,
                ...(reopened ? { cancelledAt: null } : {}),
                // The organiser's own calendar is where a meeting is booked: it counts for them.
                ...(parsed.own.isOrganizer && known.hostMemberId !== owner ? { hostMemberId: owner } : {}),
            };
            changed = differs(known, data);
            event = changed ? await tx.calendarEvent.update({ where: { id: known.id }, data }) : known;
        }

        if (!copy) {
            await tx.calendarEventCopy.create({
                data: {
                    workspaceId: mailbox.workspaceId,
                    eventId: event.id,
                    mailboxId: mailbox.id,
                    memberId: owner,
                    providerEventId: parsed.providerEventId,
                    responseStatus: parsed.own.responseStatus,
                    isOrganizer: parsed.own.isOrganizer,
                },
            });
        } else if (
            copy.responseStatus !== parsed.own.responseStatus ||
            copy.isOrganizer !== parsed.own.isOrganizer ||
            copy.eventId !== event.id
        ) {
            changed = true;
            await tx.calendarEventCopy.update({
                where: { id: copy.id },
                data: {
                    eventId: event.id,
                    responseStatus: parsed.own.responseStatus,
                    isOrganizer: parsed.own.isOrganizer,
                },
            });
        }

        const { context } = run;
        const recorded: DomainEvent[] = [];
        const people = await personsByAddress(
            tx,
            parsed.attendees.map((a) => a.address),
        );
        // Leads come only from meetings that count: an outside attendee who is no one yet becomes a person
        // the calendar's owner owns; one who is a person nobody owns is given to them.
        const leadsFor = new Set<string>();
        if (counts) {
            for (const attendee of outside) {
                if (people.has(attendee.address)) continue;
                const created = await this.createLead(tx, context, attendee, owner);
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
                const updated = await this.people.updateIn(tx, context, person.id, { ownerId: owner });
                if (updated.event) recorded.push(updated.event);
            }
        }

        const participants = {
            eventId: event.id,
            workspaceId: mailbox.workspaceId,
            // Only the organiser's calendar is sure to list every guest: a guest's may hide the others.
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
     * A new person for an outside attendee, owned by `owner`; nothing when a deleted person holds the
     * address (someone took them out of the CRM; a meeting does not bring them back).
     */
    private async createLead(
        tx: WorkspaceClient,
        context: WorkspaceRunContext,
        attendee: ParsedAttendee,
        owner: string,
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
        const { row, event } = await this.people.createIn(tx, context, {
            ...nameFromDisplay(attendee.displayName, attendee.address),
            emails: { primary: attendee.address, additional: [] },
            source: CALENDAR_LEAD_SOURCE,
            ownerId: owner,
            companyId: company?.id ?? null,
        });
        return { id: row.id, event };
    }

    /**
     * Brings the meeting's attendee rows in line with the invitation: new ones added, answers and matches
     * followed. Those taken off are removed only as the organiser's calendar shows it (a guest's calendar
     * may hide the other guests), and never a row that brought in a lead — the member's KPI keeps it.
     * True if any changed.
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

    /**
     * Google reports the meeting called off in this calendar — the organiser cancelled it, or the member
     * took it out of their calendar. The member's copy is then a "no"; the meeting itself is cancelled
     * (and announced, once) when no member's calendar still holds it with anything but a "no".
     */
    private async writeCancelled(tx: WorkspaceClient, run: Run, providerEventId: string): Promise<boolean> {
        const copy = await tx.calendarEventCopy.findUnique({
            where: { mailboxId_providerEventId: { mailboxId: run.mailbox.id, providerEventId } },
        });
        if (!copy) return false;
        const event = await tx.calendarEvent.findUniqueOrThrow({ where: { id: copy.eventId } });
        if (copy.responseStatus === 'declined' && event.status === 'cancelled') return false;
        if (copy.responseStatus !== 'declined') {
            await tx.calendarEventCopy.update({ where: { id: copy.id }, data: { responseStatus: 'declined' } });
        }
        if (event.status === 'cancelled') return true;
        const live = await tx.calendarEventCopy.count({
            where: { eventId: event.id, responseStatus: { not: 'declined' } },
        });
        if (live > 0) return true;
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

    /**
     * One write in its own transaction. Two members' runs may store the first copy of one meeting (or the
     * same new lead) at once: the loser of the race finds the winner's rows on its second attempt.
     */
    private async store<T>(run: Run, write: (tx: WorkspaceClient) => Promise<T>): Promise<T> {
        for (let attempt = 1; ; attempt += 1) {
            try {
                // In the run's own scope: the record services read the workspace (custom fields) from it.
                return await this.scope.run(run.context, () => this.rls.withWorkspace(run.mailbox.workspaceId, write));
            } catch (error) {
                if (!(uniqueViolation(error) || error instanceof UniqueConflict)) throw error;
                if (attempt >= CALENDAR_STORE_ATTEMPTS) throw error;
            }
        }
    }

    // ── Google ───────────────────────────────────────────────────────────────────────────────

    /** One Calendar request with the mailbox's token, retrying a transient failure with backoff. */
    private async request<T>(run: Run, call: (token: string) => Promise<T>): Promise<T> {
        const sleep = run.retry.sleep ?? realSleep;
        for (let attempt = 1; ; attempt += 1) {
            try {
                const token = await this.tokens.getAccessToken(run.mailbox.workspaceId, run.mailbox.id);
                return await call(token);
            } catch (error) {
                if (!(error instanceof GoogleCalendarError) || !error.transient || attempt >= CALENDAR_RETRY_ATTEMPTS)
                    throw error;
                await sleep(gmailRetryDelayMs(attempt, run.retry.random));
            }
        }
    }

    // ── State ────────────────────────────────────────────────────────────────────────────────

    /** Drops the calendar's scope from what the mailbox's grant is recorded to carry; its mail is untouched. */
    private async forgetCalendarScope(mailbox: MailboxRow): Promise<void> {
        await this.rls.withWorkspace(mailbox.workspaceId, (tx) =>
            tx.mailbox.update({
                where: { id: mailbox.id },
                data: { grantedScopes: mailbox.grantedScopes.filter((s) => s !== GOOGLE_CALENDAR_SCOPE) },
            }),
        );
    }

    private async recordStopped(mailbox: MailboxRow, error: SyncErrorRecord): Promise<void> {
        const status: MailSyncStatus = 'failed';
        if (error.code === 'internal') this.logger.warn(`calendar of mailbox ${mailbox.id}: ${error.message}`);
        await this.rls.withWorkspace(mailbox.workspaceId, (tx) =>
            tx.calendarSyncState.upsert({
                where: { mailboxId: mailbox.id },
                create: {
                    mailboxId: mailbox.id,
                    workspaceId: mailbox.workspaceId,
                    status,
                    lastError: error as unknown as Prisma.InputJsonObject,
                },
                update: { status, lastError: error as unknown as Prisma.InputJsonObject },
            }),
        );
    }
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

function unavailableError(status: string): SyncErrorRecord {
    return {
        code: status === 'disconnected' ? 'mailbox_disconnected' : 'reconnect_needed',
        message:
            status === 'disconnected'
                ? 'the mailbox is disconnected; calendar sync stopped'
                : 'the mailbox needs to be connected again; calendar sync is paused until it is',
        at: new Date().toISOString(),
    };
}

function notGrantedError(): SyncErrorRecord {
    return {
        code: 'calendar_not_granted',
        message:
            'the mailbox’s Google connection does not include the calendar; connect it again and allow calendar access',
        at: new Date().toISOString(),
    };
}

function runError(error: unknown): SyncErrorRecord {
    const at = new Date().toISOString();
    if (error instanceof GoogleCalendarError) {
        return {
            code: `calendar.${error.reason}`,
            message: `Google Calendar refused the sync (${error.status ?? 'no answer'})`,
            at,
        };
    }
    return { code: 'internal', message: 'the calendar sync failed; it will be retried', at };
}

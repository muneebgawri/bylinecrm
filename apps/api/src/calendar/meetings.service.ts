import { Injectable } from '@nestjs/common';
import { calendarGranted, MEETING_KPI_MAX_DAYS, type MailSyncStatus } from '@bylinecrm/shared';
import { Prisma } from '@prisma/client';
import { ApiException } from '../infra/errors/api-errors';
import { RlsPrismaService, type WorkspaceClient } from '../infra/rls-prisma.service';
import { WorkspaceContext, type WorkspaceRunContext } from '../infra/workspace-context';
import { MailboxesService } from '../mail-accounts/mailboxes.service';
import { paginate, type Page } from '../records/list-query';
import { MEMBER_SUMMARY_SELECT, memberSummaryOf } from '../records/summaries';
import type { CalendarSyncView, MeetingKpiRow, MeetingKpis, MeetingView } from './responses';

const DAY_MS = 24 * 60 * 60 * 1000;

const meetingInclude = {
    copies: { select: { memberId: true, responseStatus: true, isOrganizer: true }, orderBy: { createdAt: 'asc' } },
    participants: { orderBy: [{ isOrganizer: 'desc' }, { address: 'asc' }] },
} as const satisfies Prisma.CalendarEventInclude;
type MeetingRow = Prisma.CalendarEventGetPayload<{ include: typeof meetingInclude }>;

/** One member's counts, as the KPI query returns them. */
interface KpiCounts {
    member_id: string;
    booked: number;
    booked_via_slotline: number;
    held: number;
    upcoming: number;
    cancelled: number;
    people_met: number;
    new_leads: number;
}

/**
 * Reading what calendar sync (CAL-1) stored: the meetings, each member's meeting KPIs, and where a
 * calendar's sync stands. Who sees what: an admin sees every member's meetings and KPIs; anyone else sees
 * their own — the meetings in their calendar or that count for them, and their own row of KPIs. A
 * meeting's attendees who are people are on those people's timelines for whoever can read the person.
 */
@Injectable()
export class MeetingsService {
    constructor(
        private readonly rls: RlsPrismaService,
        private readonly context: WorkspaceContext,
        private readonly mailboxes: MailboxesService,
    ) {}

    /** Meetings starting in `[from, to)` (either end open), newest first. */
    list(query: {
        memberId?: string | undefined;
        from?: string | undefined;
        to?: string | undefined;
        cursor?: string | undefined;
        limit: number;
    }): Promise<Page<MeetingView>> {
        const context = this.current();
        const memberId = this.memberFor(context, query.memberId);
        const where: Prisma.CalendarEventWhereInput = {
            ...(memberId ? { OR: [{ hostMemberId: memberId }, { copies: { some: { memberId } } }] } : {}),
            ...(query.from || query.to
                ? {
                      startsAt: {
                          ...(query.from ? { gte: new Date(query.from) } : {}),
                          ...(query.to ? { lt: new Date(query.to) } : {}),
                      },
                  }
                : {}),
        };
        return this.rls.withWorkspace(async (tx) => {
            const page = await paginate(query.limit, query.cursor, (args) =>
                tx.calendarEvent.findMany({
                    where,
                    include: meetingInclude,
                    orderBy: [{ startsAt: 'desc' }, { id: 'asc' }],
                    ...args,
                }),
            );
            const slotline = await tx.slotlineSettings.findFirst({ select: { baseUrl: true } });
            return {
                items: page.items.map((row) => meetingView(row, slotline?.baseUrl ?? null)),
                nextCursor: page.nextCursor,
            };
        });
    }

    /**
     * Each member's meeting KPIs over `[from, to)`: booked (by when the meeting was put in the calendar,
     * a recurring meeting once), held and upcoming (by when it starts; not cancelled, not declined by the
     * member), cancelled, the different people met, and the leads their meetings brought in.
     */
    kpis(input: { from: string; to: string }): Promise<MeetingKpis> {
        const context = this.current();
        const from = new Date(input.from);
        const to = new Date(input.to);
        if (!(from < to)) throw new ApiException(400, 'validation.failed', '`from` must be before `to`');
        if (to.getTime() - from.getTime() > MEETING_KPI_MAX_DAYS * DAY_MS) {
            throw new ApiException(400, 'validation.failed', `a KPI period is at most ${MEETING_KPI_MAX_DAYS} days`);
        }
        const only = isAdmin(context) ? null : this.memberFor(context, undefined);
        return this.rls.withWorkspace(async (tx) => {
            const members = await tx.workspaceMember.findMany({
                where: {
                    ...(only ? { id: only } : {}),
                    // A member who left before the period has nothing in it; one who left during it keeps their row.
                    OR: [{ leftAt: null }, { leftAt: { gt: from } }],
                },
                select: MEMBER_SUMMARY_SELECT,
                orderBy: { createdAt: 'asc' },
            });
            const counts = await kpiCounts(
                tx,
                members.map((m) => m.id),
                from,
                to,
            );
            const rows: MeetingKpiRow[] = members.map((member) => {
                const c = counts.get(member.id);
                return {
                    member: memberSummaryOf(member),
                    booked: c?.booked ?? 0,
                    bookedViaSlotline: c?.booked_via_slotline ?? 0,
                    held: c?.held ?? 0,
                    upcoming: c?.upcoming ?? 0,
                    cancelled: c?.cancelled ?? 0,
                    peopleMet: c?.people_met ?? 0,
                    newLeads: c?.new_leads ?? 0,
                };
            });
            return { from, to, rows };
        });
    }

    /** Where a mailbox's calendar sync stands, for whoever may see the mailbox (`404` otherwise). */
    async syncState(mailboxId: string): Promise<CalendarSyncView> {
        const mailbox = await this.mailboxes.get(mailboxId);
        return this.rls.withWorkspace(async (tx) => {
            const row = await tx.calendarSyncState.findUnique({ where: { mailboxId } });
            const lastError = (row?.lastError ?? null) as { code: string; message: string; at: string } | null;
            return {
                mailboxId,
                granted: calendarGranted(mailbox.grantedScopes),
                status: (row?.status ?? 'idle') as MailSyncStatus,
                lastSyncedAt: row?.lastSyncedAt ?? null,
                windowReadAt: row?.windowReadAt ?? null,
                lastError: lastError
                    ? { code: lastError.code, message: lastError.message, at: new Date(lastError.at) }
                    : null,
            };
        });
    }

    /**
     * The member a read is narrowed to: the one asked for, for an admin (or none: everyone); the caller
     * themselves for anyone else — asking for someone else is `403`, and an API key, being no one, `403`.
     */
    private memberFor(context: WorkspaceRunContext, requested: string | undefined): string | null {
        if (isAdmin(context)) return requested ?? null;
        if (!context.memberId) {
            throw new ApiException(403, 'forbidden', 'meetings are a member’s own; an API key needs the admin role');
        }
        if (requested && requested !== context.memberId) {
            throw new ApiException(403, 'forbidden', 'only an admin may read another member’s meetings');
        }
        return context.memberId;
    }

    private current(): WorkspaceRunContext {
        const context = this.context.get();
        if (!context) throw new Error('MeetingsService is used inside a workspace scope');
        return context;
    }
}

function isAdmin(context: WorkspaceRunContext): boolean {
    return context.capabilities.has('workspace:admin');
}

/** The KPI counts of `memberIds` over `[from, to)`, in one statement; a member with nothing is absent. */
async function kpiCounts(
    tx: WorkspaceClient,
    memberIds: readonly string[],
    from: Date,
    to: Date,
): Promise<Map<string, KpiCounts>> {
    if (memberIds.length === 0) return new Map();
    // "Held" is up to now (or the period's end, if sooner); "upcoming" from then. Every count is the
    // member's own: the meetings they host (booked, cancelled), or of which they hold a copy — a meeting
    // both their Google Calendar and Slotline hold counts once (`DISTINCT event_id`).
    const rows = await tx.$queryRaw<KpiCounts[]>`
        WITH m AS (SELECT unnest(${[...memberIds]}::uuid[]) AS member_id),
        attended AS (
            SELECT c.member_id, e.id AS event_id, e.starts_at
            FROM calendar_event_copies c
            JOIN calendar_events e ON e.id = c.event_id
            WHERE c.member_id = ANY(${[...memberIds]}::uuid[])
              AND c.response_status <> 'declined' AND e.status <> 'cancelled'
              AND e.starts_at >= ${from} AND e.starts_at < ${to}
        )
        SELECT m.member_id::text AS member_id,
            (SELECT count(DISTINCT e.ical_uid) FROM calendar_events e
              WHERE e.host_member_id = m.member_id AND e.booked_at >= ${from} AND e.booked_at < ${to})::int AS booked,
            (SELECT count(DISTINCT e.ical_uid) FROM calendar_events e
              WHERE e.host_member_id = m.member_id AND e.booked_via = 'slotline'
                AND e.booked_at >= ${from} AND e.booked_at < ${to})::int AS booked_via_slotline,
            (SELECT count(DISTINCT a.event_id) FROM attended a
              WHERE a.member_id = m.member_id AND a.starts_at < LEAST(${to}::timestamptz, now()))::int AS held,
            (SELECT count(DISTINCT a.event_id) FROM attended a
              WHERE a.member_id = m.member_id AND a.starts_at >= now())::int AS upcoming,
            (SELECT count(*) FROM calendar_events e
              WHERE e.host_member_id = m.member_id AND e.status = 'cancelled'
                AND e.cancelled_at >= ${from} AND e.cancelled_at < ${to})::int AS cancelled,
            (SELECT count(DISTINCT p.person_id) FROM attended a
              JOIN calendar_event_participants p ON p.event_id = a.event_id
              WHERE a.member_id = m.member_id AND a.starts_at < LEAST(${to}::timestamptz, now())
                AND p.member_id IS NULL AND p.person_id IS NOT NULL)::int AS people_met,
            -- A lead counts when the person was created (an attendee row may be older than its lead), once.
            (SELECT count(DISTINCT COALESCE(p.person_id::text, p.id::text)) FROM calendar_event_participants p
              LEFT JOIN people pe ON pe.id = p.person_id
              WHERE p.lead_created_for_member_id = m.member_id
                AND COALESCE(pe.created_at, p.created_at) >= ${from}
                AND COALESCE(pe.created_at, p.created_at) < ${to})::int AS new_leads
        FROM m`;
    return new Map(rows.map((r) => [r.member_id, r]));
}

/** A member's answer across their copies: any copy that is not a "no" is the answer; a "no" only if all are. */
function membersOf(copies: MeetingRow['copies']): MeetingView['members'] {
    const byMember = new Map<string, MeetingView['members'][number]>();
    for (const c of copies) {
        const seen = byMember.get(c.memberId);
        if (!seen || seen.responseStatus === 'declined') {
            byMember.set(c.memberId, {
                memberId: c.memberId,
                responseStatus: c.responseStatus,
                isOrganizer: c.isOrganizer || (seen?.isOrganizer ?? false),
            });
        } else if (c.isOrganizer) {
            seen.isOrganizer = true;
        }
    }
    return [...byMember.values()];
}

function meetingView(row: MeetingRow, slotlineBaseUrl: string | null): MeetingView {
    return {
        id: row.id,
        title: row.title,
        startsAt: row.startsAt,
        endsAt: row.endsAt,
        allDay: row.allDay,
        status: row.status,
        location: row.location,
        conferenceUrl: row.conferenceUrl,
        hostMemberId: row.hostMemberId,
        bookedAt: row.bookedAt,
        bookedVia: row.bookedVia,
        slotlineUrl:
            row.slotlineUid && slotlineBaseUrl
                ? `${slotlineBaseUrl}/booking/${encodeURIComponent(row.slotlineUid)}`
                : null,
        cancelledAt: row.cancelledAt,
        members: membersOf(row.copies),
        attendees: row.participants.map((p) => ({
            address: p.address,
            displayName: p.displayName,
            responseStatus: p.responseStatus,
            isOrganizer: p.isOrganizer,
            personId: p.personId,
            memberId: p.memberId,
            leadCreated: p.leadCreatedForMemberId !== null,
        })),
    };
}

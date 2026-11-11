import { TODAY_NEW_LEAD_DAYS, TODAY_REPLY_WINDOW_DAYS, TODAY_STALLED_DAYS, type TodaySection } from '@bylinecrm/shared';
import { Prisma } from '@prisma/client';

/**
 * The five Today sections as SQL (#360). Each is a `SELECT id, key` over one member's rows — `key` the moment the
 * section sorts by, ascending, so the row waiting longest comes first — that `TodayService` pages and counts the
 * same way. Every one starts from an index the table already has: `people`/`opportunities` (workspace_id,
 * owner_id), `tasks` (workspace_id, assignee_id), `mail_threads` (workspace_id, last_message_at), and then
 * `mail_messages` (workspace_id, thread_id, sent_at), `mail_participants` (message_id) and
 * `opportunity_stage_history` (workspace_id, opportunity_id, entered_at) for the lookups. Row-level security
 * still applies underneath: an own-scoped caller reads only their own records.
 */
export interface SectionParams {
    workspaceId: string;
    memberId: string;
    timeZone: string;
}

/** The start of tomorrow in the time zone: what is due "today" is due before it. */
const tomorrow = (p: SectionParams) =>
    Prisma.sql`((date_trunc('day', now() AT TIME ZONE ${p.timeZone}::text) + interval '1 day') AT TIME ZONE ${p.timeZone}::text)`;

/** Today's calendar date in the time zone. */
const todayDate = (p: SectionParams) => Prisma.sql`(now() AT TIME ZONE ${p.timeZone}::text)::date`;

/** The member's open deals: live, not closed, in an open stage. */
const openDeals = (p: SectionParams) => Prisma.sql`
    FROM opportunities o
    JOIN pipeline_stages st ON st.id = o.stage_id
    WHERE o.workspace_id = ${p.workspaceId}::uuid AND o.owner_id = ${p.memberId}::uuid
      AND o.deleted_at IS NULL AND o.closed_at IS NULL AND st.kind = 'open'`;

/**
 * Replies waiting: a conversation active in the window whose latest message is inbound and from a person who is the
 * member's, or the contact of one of the member's open deals — nobody has answered it since. A bounce is not one.
 */
function replies(p: SectionParams): Prisma.Sql {
    return Prisma.sql`
        SELECT lm.id, lm.sent_at AS key
        FROM mail_threads t
        CROSS JOIN LATERAL (
            SELECT m.id, m.direction, m.sent_at
            FROM mail_messages m
            WHERE m.workspace_id = t.workspace_id AND m.thread_id = t.id
            ORDER BY m.sent_at DESC, m.created_at DESC, m.id
            LIMIT 1
        ) lm
        WHERE t.workspace_id = ${p.workspaceId}::uuid
          AND t.last_message_at >= now() - make_interval(days => ${TODAY_REPLY_WINDOW_DAYS}::int)
          AND lm.direction = 'inbound'
          AND NOT EXISTS (SELECT 1 FROM mail_bounces b WHERE b.message_id = lm.id)
          AND EXISTS (
              SELECT 1
              FROM mail_participants mp
              JOIN people p ON p.id = mp.person_id
              WHERE mp.message_id = lm.id AND mp.role = 'from' AND p.deleted_at IS NULL
                AND (p.owner_id = ${p.memberId}::uuid
                     OR EXISTS (SELECT 1 ${openDeals(p)} AND o.point_of_contact_id = p.id))
          )`;
}

/** Follow-ups due: open deals whose cadence (CADENCE-1) falls due before tomorrow, or whose planned follow-up is today or past. */
function followUps(p: SectionParams): Prisma.Sql {
    return Prisma.sql`
        SELECT o.id, LEAST(o.cadence_due_at, o.next_follow_up_date::timestamp AT TIME ZONE ${p.timeZone}::text) AS key
        ${openDeals(p)}
          AND (o.cadence_due_at < ${tomorrow(p)} OR o.next_follow_up_date <= ${todayDate(p)})`;
}

/** New leads: the member's people made in the window whose contact status is still `new`. */
function newLeads(p: SectionParams): Prisma.Sql {
    return Prisma.sql`
        SELECT p.id, p.created_at AS key
        FROM people p
        WHERE p.workspace_id = ${p.workspaceId}::uuid AND p.owner_id = ${p.memberId}::uuid AND p.deleted_at IS NULL
          AND p.contact_status = 'new'
          AND p.created_at >= now() - make_interval(days => ${TODAY_NEW_LEAD_DAYS}::int)`;
}

/** Tasks due: open tasks assigned to the member, due before tomorrow. */
function tasks(p: SectionParams): Prisma.Sql {
    return Prisma.sql`
        SELECT t.id, t.due_at AS key
        FROM tasks t
        WHERE t.workspace_id = ${p.workspaceId}::uuid AND t.assignee_id = ${p.memberId}::uuid
          AND t.deleted_at IS NULL AND t.status <> 'done' AND t.due_at < ${tomorrow(p)}`;
}

/**
 * When a deal last moved: its last touch as CADENCE-1 derives it (mail, notes, tasks, meetings, calls, the owner's
 * stage moves), else — a deal no cadence applies to — its last stage move, else its making.
 */
export const LAST_ACTIVITY_SQL = Prisma.sql`COALESCE(
    o.cadence_touched_at,
    (SELECT max(h.entered_at) FROM opportunity_stage_history h
     WHERE h.workspace_id = o.workspace_id AND h.opportunity_id = o.id),
    o.created_at)`;

/** Stalled: open deals with nothing due today, no follow-up planned, and no activity for `TODAY_STALLED_DAYS`. */
function stalled(p: SectionParams): Prisma.Sql {
    return Prisma.sql`
        SELECT id, key FROM (
            SELECT o.id, ${LAST_ACTIVITY_SQL} AS key
            ${openDeals(p)}
              AND o.next_follow_up_date IS NULL
              AND (o.cadence_due_at IS NULL OR o.cadence_due_at >= ${tomorrow(p)})
        ) quiet
        WHERE key < now() - make_interval(days => ${TODAY_STALLED_DAYS}::int)`;
}

export const SECTION_SQL: Readonly<Record<TodaySection, (p: SectionParams) => Prisma.Sql>> = {
    replies,
    followUps,
    newLeads,
    tasks,
    stalled,
};

import { Injectable } from '@nestjs/common';
import {
    LIST_COUNT_CAP,
    TODAY_NEW_LEAD_DAYS,
    TODAY_REPLY_WINDOW_DAYS,
    TODAY_SECTIONS,
    TODAY_STALLED_DAYS,
    type MyTaskView,
    type Phones,
    type TodaySection,
} from '@bylinecrm/shared';
import { Prisma } from '@prisma/client';
import { ApiException } from '../infra/errors/api-errors';
import { RlsPrismaService, type WorkspaceClient } from '../infra/rls-prisma.service';
import { WorkspaceContext, type WorkspaceRunContext } from '../infra/workspace-context';
import { MY_TASK_SELECT, myTaskViews } from '../notifications/task-notifications.service';
import { memberInScope } from '../records/record-scope';
import { MEMBER_SUMMARY_SELECT, memberSummaryOf, personName } from '../records/summaries';
import { decodeSectionCursor, encodeSectionCursor, type SectionCursor } from './cursor';
import { SECTION_SQL, type SectionParams } from './sections';
import type { TodayDealView, TodayLeadView, TodayPersonView, TodayReplyView, TodayView } from './responses';

export interface TodayQuery {
    memberId?: string | undefined;
    timeZone: string;
    limit: number;
}

/** One section's count and page, whatever its rows are. */
export interface SectionPage<T> {
    count: number;
    countIsExact: boolean;
    items: T[];
    nextCursor: string | null;
}

interface SectionItems {
    replies: TodayReplyView;
    followUps: TodayDealView;
    newLeads: TodayLeadView;
    tasks: MyTaskView;
    stalled: TodayDealView;
}

interface KeyRow {
    id: string;
    key: Date;
}

const PERSON_SELECT = {
    id: true,
    nameFirst: true,
    nameLast: true,
    emailPrimary: true,
    phones: true,
    source: true,
    company: { select: { id: true, name: true, deletedAt: true } },
} as const satisfies Prisma.PersonSelect;
type PersonRow = Prisma.PersonGetPayload<{ select: typeof PERSON_SELECT }>;

/**
 * Today (#360): what one member should do today — replies waiting, follow-ups due, new leads to contact, tasks due
 * and deals gone quiet. Each section is a count (capped at `LIST_COUNT_CAP`) and a keyset page, most urgent first,
 * read under the caller's row-level security in one transaction. Whose day it is follows `memberInScope`: an admin
 * may read any member's; anyone else reads their own, and an API key, being no one, must name a member as an admin.
 */
@Injectable()
export class TodayService {
    constructor(
        private readonly rls: RlsPrismaService,
        private readonly context: WorkspaceContext,
    ) {}

    /** Every section's count and first page. */
    overview(query: TodayQuery): Promise<TodayView> {
        const context = this.current();
        const memberId = whose(context, query.memberId);
        return this.rls.withWorkspace(async (tx) => {
            const member = await tx.workspaceMember.findUnique({
                where: { id: memberId },
                select: MEMBER_SUMMARY_SELECT,
            });
            if (!member) throw new ApiException(404, 'not_found', 'member not found');
            const params: SectionParams = { workspaceId: context.workspaceId, memberId, timeZone: query.timeZone };
            const [{ date }] = await tx.$queryRaw<[{ date: string }]>`
                SELECT to_char(now() AT TIME ZONE ${query.timeZone}::text, 'YYYY-MM-DD') AS date`;
            const sections = {} as { [S in TodaySection]: SectionPage<SectionItems[S]> };
            // One connection, one transaction: the sections are read one after another.
            for (const name of TODAY_SECTIONS) {
                (sections as Record<TodaySection, unknown>)[name] = await readSection(
                    tx,
                    name,
                    params,
                    query.limit,
                    undefined,
                );
            }
            return {
                member: memberSummaryOf(member),
                date,
                windows: {
                    replyDays: TODAY_REPLY_WINDOW_DAYS,
                    newLeadDays: TODAY_NEW_LEAD_DAYS,
                    stalledDays: TODAY_STALLED_DAYS,
                },
                ...sections,
            };
        });
    }

    /** One section's page after `cursor` (the first page without one), with its count. */
    section<S extends TodaySection>(
        name: S,
        query: TodayQuery & { cursor?: string | undefined },
    ): Promise<SectionPage<SectionItems[S]>> {
        const context = this.current();
        const memberId = whose(context, query.memberId);
        const cursor = query.cursor === undefined ? undefined : decodeSectionCursor(query.cursor);
        const params: SectionParams = { workspaceId: context.workspaceId, memberId, timeZone: query.timeZone };
        return this.rls.withWorkspace((tx) => readSection(tx, name, params, query.limit, cursor));
    }

    private current(): WorkspaceRunContext {
        const context = this.context.get();
        if (!context) throw new Error('TodayService is used inside a workspace scope');
        return context;
    }
}

/** The member whose day is read: `memberInScope`'s rule, and an admin who names no one reads their own. */
function whose(context: WorkspaceRunContext, requested: string | undefined): string {
    const memberId = memberInScope(context, requested, 'Today lists') ?? context.memberId;
    if (!memberId) throw new ApiException(400, 'validation.failed', 'an API key must name the member (`memberId`)');
    return memberId;
}

/** A section's count and page: its keys from SQL, then its rows, in the keys' order. */
async function readSection<S extends TodaySection>(
    tx: WorkspaceClient,
    name: S,
    params: SectionParams,
    limit: number,
    cursor: SectionCursor | undefined,
): Promise<SectionPage<SectionItems[S]>> {
    const base = SECTION_SQL[name](params);
    const after = cursor
        ? Prisma.sql`WHERE (s.key, s.id) > (${cursor.key}::timestamptz, ${cursor.id}::uuid)`
        : Prisma.empty;
    const keys = await tx.$queryRaw<KeyRow[]>`
        SELECT s.id, s.key FROM (${base}) s ${after}
        ORDER BY s.key ASC, s.id ASC
        LIMIT ${limit + 1}::int`;
    const [{ count }] = await tx.$queryRaw<[{ count: number }]>`
        SELECT count(*)::int AS count FROM (SELECT 1 FROM (${base}) s LIMIT ${LIST_COUNT_CAP + 1}::int) capped`;
    const page = keys.slice(0, limit);
    const last = page[page.length - 1];
    const items = (await HYDRATE[name](tx, page)) as SectionItems[S][];
    return {
        count: Math.min(count, LIST_COUNT_CAP),
        countIsExact: count <= LIST_COUNT_CAP,
        items,
        nextCursor: keys.length > limit && last ? encodeSectionCursor(last) : null,
    };
}

type Hydrate = (tx: WorkspaceClient, rows: readonly KeyRow[]) => Promise<unknown[]>;

/** Each section's rows for its keys, in the keys' order; a row gone since (or unreadable) drops out. */
const HYDRATE: Readonly<Record<TodaySection, Hydrate>> = {
    replies: hydrateReplies,
    followUps: (tx, rows) => hydrateDeals(tx, rows, 'due'),
    newLeads: hydrateLeads,
    tasks: hydrateTasks,
    stalled: (tx, rows) => hydrateDeals(tx, rows, 'quiet'),
};

function inOrder<T extends { id: string }>(rows: readonly KeyRow[], found: readonly T[]): T[] {
    const byId = new Map(found.map((r) => [r.id, r]));
    return rows.map((r) => byId.get(r.id)).filter((r): r is T => r !== undefined);
}

function personView(p: PersonRow): TodayPersonView {
    return {
        id: p.id,
        name: personName(p.nameFirst, p.nameLast, p.emailPrimary) || 'Unnamed person',
        email: p.emailPrimary,
        phones: p.phones as unknown as Phones,
        source: p.source,
        company: p.company && !p.company.deletedAt ? { id: p.company.id, name: p.company.name } : null,
    };
}

async function hydrateReplies(tx: WorkspaceClient, rows: readonly KeyRow[]): Promise<TodayReplyView[]> {
    if (rows.length === 0) return [];
    const messages = await tx.mailMessage.findMany({
        where: { id: { in: rows.map((r) => r.id) } },
        select: {
            id: true,
            threadId: true,
            subject: true,
            snippet: true,
            sentAt: true,
            participants: {
                where: { role: 'from', personId: { not: null } },
                select: { personId: true },
                orderBy: { id: 'asc' },
            },
        },
    });
    const personIds = [...new Set(messages.flatMap((m) => m.participants.map((p) => p.personId!)))];
    const people = new Map(
        (await tx.person.findMany({ where: { id: { in: personIds }, deletedAt: null }, select: PERSON_SELECT })).map(
            (p) => [p.id, p],
        ),
    );
    return inOrder(rows, messages).flatMap((m) => {
        const person = m.participants.map((p) => people.get(p.personId!)).find((p) => p !== undefined);
        if (!person) return [];
        return [
            {
                messageId: m.id,
                threadId: m.threadId,
                subject: m.subject,
                snippet: m.snippet,
                receivedAt: m.sentAt,
                person: personView(person),
            },
        ];
    });
}

async function hydrateDeals(
    tx: WorkspaceClient,
    rows: readonly KeyRow[],
    keyIs: 'due' | 'quiet',
): Promise<TodayDealView[]> {
    if (rows.length === 0) return [];
    const deals = await tx.opportunity.findMany({
        where: { id: { in: rows.map((r) => r.id) }, deletedAt: null },
        select: {
            id: true,
            name: true,
            amountMinor: true,
            currency: true,
            pipelineId: true,
            stage: { select: { id: true, name: true } },
            cadenceDueAt: true,
            cadenceTouchedAt: true,
            cadenceOverdue: true,
            nextFollowUpDate: true,
            company: { select: { id: true, name: true, deletedAt: true } },
            pointOfContact: { select: { ...PERSON_SELECT, deletedAt: true } },
        },
    });
    const keys = new Map(rows.map((r) => [r.id, r.key]));
    return inOrder(rows, deals).map((d) => ({
        id: d.id,
        name: d.name,
        amount: d.amountMinor === null ? null : { amountMinor: Number(d.amountMinor), currency: d.currency },
        currency: d.currency,
        pipelineId: d.pipelineId,
        stage: d.stage,
        dueAt: keyIs === 'due' ? (keys.get(d.id) ?? null) : d.cadenceDueAt,
        nextFollowUpDate: d.nextFollowUpDate ? d.nextFollowUpDate.toISOString().slice(0, 10) : null,
        cadenceOverdue: d.cadenceOverdue,
        lastActivityAt: keyIs === 'quiet' ? (keys.get(d.id) ?? null) : d.cadenceTouchedAt,
        company: d.company && !d.company.deletedAt ? { id: d.company.id, name: d.company.name } : null,
        contact: d.pointOfContact && !d.pointOfContact.deletedAt ? personView(d.pointOfContact) : null,
    }));
}

async function hydrateLeads(tx: WorkspaceClient, rows: readonly KeyRow[]): Promise<TodayLeadView[]> {
    if (rows.length === 0) return [];
    const people = await tx.person.findMany({
        where: { id: { in: rows.map((r) => r.id) }, deletedAt: null },
        select: { ...PERSON_SELECT, createdAt: true },
    });
    return inOrder(rows, people).map((p) => ({ ...personView(p), createdAt: p.createdAt }));
}

async function hydrateTasks(tx: WorkspaceClient, rows: readonly KeyRow[]): Promise<MyTaskView[]> {
    if (rows.length === 0) return [];
    const found = await tx.task.findMany({
        where: { id: { in: rows.map((r) => r.id) }, deletedAt: null },
        select: MY_TASK_SELECT,
    });
    return myTaskViews(tx, inOrder(rows, found));
}

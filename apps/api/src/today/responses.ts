import { z } from 'zod';
import { myTaskView } from '../notifications/responses';
import { dateTime, id, money, named, phones } from '../openapi/responses';
import { memberSummaryView } from '../workspace/responses';

/** Today (#360) as the API returns it: each section a count and one page, most urgent first. */

const related = z.object({ id, name: z.string() });

/** A person as a Today row needs them: to name them, open them, email or call them. */
const todayPerson = named(
    'TodayPerson',
    z.object({
        id,
        name: z.string().meta({ description: 'First and last name, else the primary email.' }),
        email: z.string().nullable(),
        phones,
        source: z
            .string()
            .nullable()
            .meta({ description: 'Where they came from; mail to a sourced lead carries an unsubscribe.' }),
        company: related.nullable(),
    }),
);

const todayReply = named(
    'TodayReply',
    z.object({
        messageId: id,
        threadId: id,
        subject: z.string(),
        snippet: z.string(),
        receivedAt: dateTime,
        /** Who wrote it. */
        person: todayPerson,
    }),
);

const todayDeal = named(
    'TodayDeal',
    z.object({
        id,
        name: z.string(),
        amount: money.nullable(),
        currency: z.string(),
        pipelineId: id,
        stage: related,
        dueAt: dateTime.nullable().meta({
            description:
                'When the follow-up fell due: the earlier of the cadence’s due time and the start of `nextFollowUpDate`.',
        }),
        nextFollowUpDate: z.string().nullable().meta({ description: 'A calendar date, `YYYY-MM-DD`.' }),
        cadenceOverdue: z.boolean(),
        lastActivityAt: dateTime.nullable().meta({
            description: 'The last touch (CADENCE-1), else the last stage move, else when the deal was made.',
        }),
        company: related.nullable(),
        /** The point of contact, when the caller may read them. */
        contact: todayPerson.nullable(),
    }),
);

const todayLead = named('TodayLead', todayPerson.extend({ createdAt: dateTime }));

/** One section: its size (up to `LIST_COUNT_CAP`; past it `countIsExact` is false) and one page. */
function section<S extends z.ZodType>(name: string, item: S) {
    return named(
        name,
        z.object({
            count: z.number().int(),
            countIsExact: z.boolean(),
            items: z.array(item),
            nextCursor: z.string().nullable(),
        }),
    );
}

export const todayReplies = section('TodayReplies', todayReply);
export const todayDeals = section('TodayDeals', todayDeal);
export const todayLeads = section('TodayLeads', todayLead);
export const todayTasks = section('TodayTasks', myTaskView);

export const todayView = named(
    'Today',
    z.object({
        member: memberSummaryView,
        date: z.string().meta({ description: 'Today in the time zone asked for, `YYYY-MM-DD`.' }),
        windows: z.object({
            replyDays: z.number().int().meta({ description: 'Replies older than this many days are not listed.' }),
            newLeadDays: z.number().int().meta({ description: 'A new lead was made at most this many days ago.' }),
            stalledDays: z.number().int().meta({ description: 'A stalled deal has been quiet this many days.' }),
        }),
        // Each section's rule is in the route's description (today.controller.ts).
        replies: todayReplies,
        followUps: todayDeals,
        newLeads: todayLeads,
        tasks: todayTasks,
        stalled: todayDeals,
    }),
);

export type TodayView = z.output<typeof todayView>;
export type TodayRepliesView = z.output<typeof todayReplies>;
export type TodayDealsView = z.output<typeof todayDeals>;
export type TodayLeadsView = z.output<typeof todayLeads>;
export type TodayTasksView = z.output<typeof todayTasks>;
export type TodayPersonView = z.output<typeof todayPerson>;
export type TodayDealView = z.output<typeof todayDeal>;
export type TodayReplyView = z.output<typeof todayReply>;
export type TodayLeadView = z.output<typeof todayLead>;

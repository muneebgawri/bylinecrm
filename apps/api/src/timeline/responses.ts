import { ACTOR_KINDS, LINKED_OBJECTS, type TimelineActor } from '@bylinecrm/shared';
import { z } from 'zod';
import { dateTime, id, money, named, page, recordTarget } from '../openapi/responses';

/** Timeline entries (P1-3), as the API returns them. */

/** Who an entry is attributed to: a record actor, a stage rule, or an integration (its source as `id`). */
const timelineActor: z.ZodType<TimelineActor> = z.union([
    z.object({ kind: z.enum(ACTOR_KINDS), id: id.nullable() }),
    z.object({ kind: z.enum(['rule', 'external']), id: z.string().nullable() }),
]);

export const timelineActivityView = named(
    'TimelineActivity',
    z.object({
        id,
        target: recordTarget,
        kind: z.string().meta({ example: 'person.updated' }),
        happenedAt: dateTime,
        actor: named('TimelineActor', timelineActor),
        properties: z.record(z.string(), z.unknown()),
        linked: z.object({ type: z.enum(LINKED_OBJECTS), id }).nullable(),
        createdAt: dateTime,
    }),
);
export const timelinePage = named('TimelinePage', page(timelineActivityView));

export const externalActivityResult = named(
    'ExternalActivityResult',
    z.object({
        activity: timelineActivityView,
        created: z.boolean().meta({ description: '`false` when the idempotency key was seen before.' }),
    }),
);

const feedMember = z.object({ id, name: z.string().nullable() });

/** The live deal feed's entry: a headline only, told to everyone in the workspace. */
export const dealFeedItem = named(
    'DealFeedItem',
    z.object({
        id,
        kind: z.enum(['created', 'stage', 'won', 'lost', 'paid']),
        happenedAt: dateTime,
        actor: z.object({ kind: z.enum(['member', 'rule']), member: feedMember.nullable() }),
        deal: z.object({
            id,
            name: z.string(),
            amount: money.nullable(),
            owner: feedMember.nullable(),
            canOpen: z.boolean().meta({ description: 'Whether the caller may open the deal (their owner scope).' }),
        }),
        fromStage: z.string().nullable(),
        toStage: z.string().nullable(),
    }),
);
export const dealFeed = named('DealFeed', z.object({ items: z.array(dealFeedItem) }));

export type DealFeedItem = z.output<typeof dealFeedItem>;
export type TimelineActivityView = z.output<typeof timelineActivityView>;
export type ExternalActivityResult = z.output<typeof externalActivityResult>;

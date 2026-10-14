import { Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import {
    EXTERNAL_KIND_PREFIX,
    type DomainEvent,
    type EmailSummary,
    type EmailTrackingPayload,
    type SuppressionEventPayload,
    type LinkedObject,
    type Money,
    type RecordObject,
    type RecordTarget,
    type TimelineActor,
    isLinkedObject,
    isRecordObject,
    timelineKindOf,
} from '@bylinecrm/shared';
import type { Prisma } from '@prisma/client';
import { uniqueViolation } from '../infra/prisma-errors';
import type { DeliveredEvent } from '../events/outbox-consumer';
import { RlsPrismaService, type WorkspaceClient } from '../infra/rls-prisma.service';
import { WorkspaceContext, type WorkspaceRunContext } from '../infra/workspace-context';
import { actorOf } from '../records/actor';
import { type Page, paginate } from '../records/list-query';
import { stored } from '../records/references';
import { readableTargets } from '../records/targets';
import type { TimelineActivityView, ExternalActivityResult } from './responses';
export type { TimelineActivityView, ExternalActivityResult } from './responses';

export interface TimelineQuery {
    target: RecordTarget;
    /** Prefixes of `kind` to keep; empty means every kind. */
    kinds: readonly string[];
    cursor?: string | undefined;
    limit: number;
}

export interface ExternalActivityInput {
    target: RecordTarget;
    kind: string;
    happenedAt: Date;
    title: string;
    url?: string | undefined;
    amount?: Money | undefined;
    source: string;
    idempotencyKey: string;
}

type ActivityRow = Prisma.TimelineActivityGetPayload<object>;

/** The row a write produces, before the client's id is known. */
type NewRow = Omit<Prisma.TimelineActivityCreateManyInput, 'id' | 'workspaceId' | 'createdAt' | 'eventId'>;

/**
 * Reading the timeline, and the two ways an entry gets onto it: a domain event (through
 * `writeFor`, which the subscriber calls) and an integration's report (`recordExternal`).
 * Nothing here updates or deletes — the app role cannot, and no route asks to.
 */
@Injectable()
export class TimelineService {
    constructor(
        private readonly rls: RlsPrismaService,
        private readonly context: WorkspaceContext,
    ) {}

    /**
     * The entries on one record, newest first. A company's timeline merges the activity of its
     * people with its own; a target the caller cannot see "has no timeline" (`404`). Visibility
     * is the targets' own — `readableTargets` under the caller's policies, the one rule.
     */
    list(query: TimelineQuery): Promise<Page<TimelineActivityView>> {
        this.current();
        return this.rls.withWorkspace(async (tx) => {
            const visible = await readableTargets(tx, [query.target]);
            if (visible.length === 0) throw new NotFoundException('target not found');
            const targets = await this.mergedTargets(tx, query.target);
            const page = await paginate(query.limit, query.cursor, (args) =>
                tx.timelineActivity.findMany({
                    where: {
                        OR: targets.map((t) => ({ targetType: t.type, targetId: t.id })),
                        ...(query.kinds.length > 0
                            ? { AND: [{ OR: query.kinds.map((k) => ({ kind: { startsWith: k } })) }] }
                            : {}),
                    },
                    orderBy: [{ happenedAt: 'desc' }, { id: 'asc' }],
                    ...args,
                }),
            );
            return { items: page.items.map(view), nextCursor: page.nextCursor };
        });
    }

    /**
     * Writes the entries a domain event leaves: one on the record itself, or — for a note, task
     * or attachment — one on each record it is on (PAR-014). The linked thing's current name is
     * read once so the entry can be rendered without a lookup; an `updated` event's diff is
     * taken from the event, never recomputed. Each entry carries the outbox event's id, unique per
     * record, so a redelivered event writes nothing new (P1-6). Returns how many rows were written.
     */
    writeFor({ id: eventId, event }: DeliveredEvent): Promise<number> {
        return this.rls.withWorkspace(event.workspaceId, async (tx) => {
            const rows = await rowsFor(tx, event);
            if (rows.length === 0) return 0;
            const result = await tx.timelineActivity.createMany({
                data: rows.map((row) => ({ ...row, workspaceId: event.workspaceId, eventId })),
                skipDuplicates: true,
            });
            return result.count;
        });
    }

    /**
     * An integration's report, as an `external.<kind>` entry on one record. Idempotent per
     * (workspace, source, key): a replay returns the entry already written, `created: false`.
     * The target must be a live record the caller can see — `422` otherwise, as for any write.
     */
    async recordExternal(input: ExternalActivityInput): Promise<ExternalActivityResult> {
        const context = this.current();
        const lookup = (tx: WorkspaceClient) =>
            tx.timelineActivity.findUnique({
                where: {
                    workspaceId_source_idempotencyKey: {
                        workspaceId: context.workspaceId,
                        source: input.source,
                        idempotencyKey: input.idempotencyKey,
                    },
                },
            });
        // A replay is the common case for a retrying sender: answer it without a write.
        const existing = await this.rls.withWorkspace(lookup);
        if (existing) return { activity: view(existing), created: false };
        try {
            const row = await this.rls.withWorkspace(async (tx) => {
                const visible = await readableTargets(tx, [input.target]);
                if (visible.length === 0) {
                    throw new UnprocessableEntityException(`target ${input.target.type}:${input.target.id} not found`);
                }
                return tx.timelineActivity.create({
                    data: {
                        workspace: { connect: { id: context.workspaceId } },
                        targetType: input.target.type,
                        targetId: input.target.id,
                        kind: input.kind,
                        happenedAt: input.happenedAt,
                        actor: { kind: 'external', id: input.source } satisfies TimelineActor,
                        properties: asJson({
                            title: input.title,
                            ...(input.url !== undefined ? { url: input.url } : {}),
                            ...(input.amount !== undefined ? { amount: input.amount } : {}),
                            recordedBy: actorOf(context),
                        }),
                        source: input.source,
                        idempotencyKey: input.idempotencyKey,
                    },
                });
            });
            return { activity: view(row), created: true };
        } catch (error) {
            // Two senders raced on the same key: the index kept one; the failed transaction is
            // over, so the entry is read in a new one.
            if (!uniqueViolation(error)) throw error;
            const won = await this.rls.withWorkspace(lookup);
            if (!won) throw error;
            return { activity: view(won), created: false };
        }
    }

    /** A company's timeline is its own plus its live people's; any other target is itself. */
    private async mergedTargets(tx: WorkspaceClient, target: RecordTarget): Promise<RecordTarget[]> {
        if (target.type !== 'company') return [target];
        const people = await tx.person.findMany({
            where: { companyId: target.id, deletedAt: null },
            select: { id: true },
        });
        return [target, ...people.map((p) => ({ type: 'person' as const, id: p.id }))];
    }

    private current(): WorkspaceRunContext {
        const context = this.context.get();
        if (!context) throw new Error('TimelineService is used inside a workspace scope');
        return context;
    }
}

/**
 * The fields of a record that someone other than the import changed after `after` (#185): the
 * `diff` keys of the record's own entries (not a note's or a task's on it) with any actor but the
 * import's, later than that moment. What the Twenty sync's precedence rule asks the timeline.
 */
export async function fieldsEditedAfter(
    tx: WorkspaceClient,
    target: { type: RecordObject; id: string },
    after: Date,
): Promise<Set<string>> {
    const rows = await tx.timelineActivity.findMany({
        where: { targetType: target.type, targetId: target.id, linkedType: null, happenedAt: { gt: after } },
        select: { actor: true, properties: true },
    });
    const fields = new Set<string>();
    for (const row of rows) {
        if (stored<TimelineActor>(row.actor).kind === 'import') continue;
        const diff = stored<{ diff?: Record<string, unknown> }>(row.properties).diff;
        for (const field of Object.keys(diff ?? {})) fields.add(field);
    }
    return fields;
}

/** The rows one event leaves, by the shape of its object: a record's own entry, or one per target. */
async function rowsFor(tx: WorkspaceClient, event: DomainEvent): Promise<NewRow[]> {
    const kind = timelineKindOf(event);
    const base = {
        kind,
        // Mail is on the timeline at the moment it was sent — also when it is linked later.
        happenedAt: new Date(event.email?.sentAt ?? event.occurredAt),
        actor: event.actor,
    };
    if (isRecordObject(event.object)) {
        return [
            {
                ...base,
                targetType: event.object,
                targetId: event.recordId,
                properties: asJson(event.diff ? { diff: event.diff } : {}),
            },
        ];
    }
    if (isLinkedObject(event.object)) {
        const targets = event.targets ?? [];
        if (targets.length === 0) return [];
        const name = await linkedName(tx, event.object, event.recordId);
        const properties = asJson({
            linked: { type: event.object, id: event.recordId, name },
            ...(event.diff ? { diff: event.diff } : {}),
            ...(event.email ? { email: emailEntry(event.email) } : {}),
            ...(event.suppression ? { suppression: suppressionEntry(event.suppression) } : {}),
            ...(event.tracking ? { tracking: trackingEntry(event.tracking) } : {}),
        });
        return targets.map((t) => ({
            ...base,
            targetType: t.type,
            targetId: t.id,
            linkedType: event.object as LinkedObject,
            linkedId: event.recordId,
            properties,
        }));
    }
    return [];
}

/** The display name a linked thing has right now, cached on the entry; `null` once it is gone. */
async function linkedName(tx: WorkspaceClient, type: LinkedObject, id: string): Promise<string | null> {
    switch (type) {
        case 'note':
            return (await tx.note.findUnique({ where: { id }, select: { title: true } }))?.title ?? null;
        case 'task':
            return (await tx.task.findUnique({ where: { id }, select: { title: true } }))?.title ?? null;
        case 'attachment':
            return (await tx.attachment.findUnique({ where: { id }, select: { name: true } }))?.name ?? null;
        case 'email':
            // A synced message, or — for a tracking event (P3-4) — the send it is about.
            return (
                (await tx.mailMessage.findUnique({ where: { id }, select: { subject: true } }))?.subject ??
                (await tx.mailOutbound.findUnique({ where: { id }, select: { subject: true } }))?.subject ??
                null
            );
        case 'suppression':
            return (await tx.suppression.findUnique({ where: { id }, select: { address: true } }))?.address ?? null;
    }
}

/** What a click or an open shows (P3-4): the link, and that an open is indicative — never the client. */
function trackingEntry(tracking: EmailTrackingPayload) {
    return { url: tracking.url, indicative: tracking.indicative, sequenceStepId: tracking.sequenceStepId };
}

/** What a suppression's entry shows (#114): why the address is on the list, by whom, and the note. */
function suppressionEntry(suppression: SuppressionEventPayload) {
    return { reason: suppression.reason, source: suppression.source, note: suppression.note };
}

/**
 * What a synced email's entry shows (P2-2): enough to read the line without opening the thread —
 * never the body, which the thread route serves to those allowed to read it.
 */
function emailEntry(email: EmailSummary) {
    return {
        direction: email.direction,
        subject: email.subject,
        snippet: email.snippet,
        from: email.from,
        threadId: email.threadId,
        mailboxId: email.mailboxId,
    };
}

/**
 * A value built from validated inputs and catalogue types, as the JSON column takes it. Every
 * write of `properties` goes through here; it names the one place the shape is asserted.
 */
function asJson(value: object): Prisma.InputJsonObject {
    return value as unknown as Prisma.InputJsonObject;
}

export function view(row: ActivityRow): TimelineActivityView {
    return {
        id: row.id,
        target: { type: row.targetType as RecordObject, id: row.targetId },
        kind: row.kind,
        happenedAt: row.happenedAt,
        actor: stored<TimelineActor>(row.actor),
        properties: stored<Record<string, unknown>>(row.properties),
        linked: row.linkedType && row.linkedId ? { type: row.linkedType, id: row.linkedId } : null,
        createdAt: row.createdAt,
    };
}

/** True for the kinds an integration may write: `external.` and a short name. */
export function isExternalKind(kind: string): boolean {
    return kind.startsWith(EXTERNAL_KIND_PREFIX);
}

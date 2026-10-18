import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
    NO_TRACKING_COUNTS,
    type TrackingCounts,
    SEQUENCE_WINDOW_DEFAULTS,
    type Actor,
    type DomainEvent,
    type SequenceCounts,
    type SequenceView,
} from '@bylinecrm/shared';
import type { Prisma } from '@prisma/client';
import { DomainEvents } from '../events/domain-events.service';
import { ApiException, StateConflict, ValidationFailed } from '../infra/errors/api-errors';
import { RlsPrismaService, type WorkspaceClient } from '../infra/rls-prisma.service';
import { WorkspaceContext, type WorkspaceRunContext } from '../infra/workspace-context';
import { actorOf } from '../records/actor';
import { diffOf } from '../records/diff';
import { readMailSettings } from '../templates/mail-settings.service';
import type { CreateSequenceDto, StepInput, UpdateSequenceDto } from './dto';
import { isTimeZone } from './schedule';
import { SequenceRunner } from './sequence-runner';
import { trackingCountsForSteps } from '../tracking/tracking-counts';
import { callerMemberId } from '../infra/caller-member';
import { mayChangeVisibility, sequenceVisibleWhere } from './visibility';

type SequenceRow = Prisma.SequenceGetPayload<{ include: { steps: true } }>;

const DIFF_FIELDS = ['name', 'status', 'pipelineId', 'stopOnPipelineExit', 'timeZone', 'window', 'visibility'] as const;

/**
 * Sequences (P3-3, FR-CRMS-5): a workspace's drips — their steps and their lifecycle. A draft's steps
 * are rewritten freely; once a sequence has run, its existing steps keep their order (enrolments know
 * where they are by position) and may be edited or added to — restructuring means a new sequence.
 * Activating checks what an outreach send needs, so a sequence never activates into failing sends.
 */
@Injectable()
export class SequencesService {
    constructor(
        private readonly rls: RlsPrismaService,
        private readonly context: WorkspaceContext,
        private readonly events: DomainEvents,
        private readonly runner: SequenceRunner,
    ) {}

    /** The sequences the caller may see (#192): every one for an admin, else the shared ones and their own. */
    async list(): Promise<SequenceView[]> {
        const context = this.current();
        return this.rls.withWorkspace(async (tx) => {
            const rows = await tx.sequence.findMany({
                where: await sequenceVisibleWhere(tx, context),
                include: { steps: true },
                orderBy: { createdAt: 'desc' },
            });
            const counts = await countsFor(
                tx,
                rows.map((r) => r.id),
            );
            const tracking = await trackingCountsForSteps(
                tx,
                rows.flatMap((r) => r.steps.map((s) => s.id)),
            );
            return rows.map((r) => view(r, counts.get(r.id), tracking));
        });
    }

    async get(id: string): Promise<SequenceView> {
        const context = this.current();
        return this.rls.withWorkspace(async (tx) => {
            const row = await find(tx, id, context);
            return view(
                row,
                (await countsFor(tx, [id])).get(id),
                await trackingCountsForSteps(
                    tx,
                    row.steps.map((s) => s.id),
                ),
            );
        });
    }

    async create(input: CreateSequenceDto): Promise<SequenceView> {
        const context = this.current();
        const timeZone = input.timeZone ?? 'UTC';
        assertZone(timeZone);
        const window = input.window ?? SEQUENCE_WINDOW_DEFAULTS;
        return this.rls.withWorkspace(async (tx) => {
            if (input.pipelineId) await assertPipeline(tx, input.pipelineId);
            const row = await tx.sequence.create({
                data: {
                    workspaceId: context.workspaceId,
                    name: input.name,
                    timeZone,
                    pipelineId: input.pipelineId ?? null,
                    stopOnPipelineExit: input.stopOnPipelineExit ?? true,
                    windowStartMinute: window.startMinute,
                    windowEndMinute: window.endMinute,
                    windowDays: window.days,
                    createdBy: actorOf(context) as unknown as Prisma.InputJsonValue,
                    // #192: the maker's (or their API key's member's); shared unless they say private.
                    ownerMemberId: await callerMemberId(tx, context),
                    visibility: input.visibility ?? 'shared',
                },
                include: { steps: true },
            });
            await this.announce(tx, context, 'sequence.created', row.id);
            return view(row, undefined);
        });
    }

    async update(id: string, patch: UpdateSequenceDto): Promise<SequenceView> {
        const context = this.current();
        if (patch.timeZone) assertZone(patch.timeZone);
        return this.rls.withWorkspace(async (tx) => {
            const before = await find(tx, id, context);
            if (before.status === 'archived') throw new StateConflict('an archived sequence is read-only');
            if (patch.pipelineId) await assertPipeline(tx, patch.pipelineId);
            if (
                patch.visibility !== undefined &&
                patch.visibility !== before.visibility &&
                !mayChangeVisibility(context, await callerMemberId(tx, context), before)
            ) {
                throw new ForbiddenException('only the sequence’s owner or an admin changes who sees it');
            }
            const data: Prisma.SequenceUncheckedUpdateInput = {};
            if (patch.name !== undefined) data.name = patch.name;
            if (patch.timeZone !== undefined) data.timeZone = patch.timeZone;
            if (patch.pipelineId !== undefined) data.pipelineId = patch.pipelineId;
            if (patch.stopOnPipelineExit !== undefined) data.stopOnPipelineExit = patch.stopOnPipelineExit;
            if (patch.visibility !== undefined) data.visibility = patch.visibility;
            if (patch.window) {
                data.windowStartMinute = patch.window.startMinute;
                data.windowEndMinute = patch.window.endMinute;
                data.windowDays = patch.window.days;
            }
            const after = await tx.sequence.update({
                where: { id },
                data,
                include: { steps: true },
            });
            const diff = diffOf(view(before, undefined), view(after, undefined), DIFF_FIELDS);
            if (Object.keys(diff).length > 0) await this.announce(tx, context, 'sequence.updated', id, diff);
            return view(after, (await countsFor(tx, [id])).get(id));
        });
    }

    /**
     * Replaces the step list. A draft's list is rewritten; a sequence that has run keeps its existing
     * steps, in order, as the start of the new list (each may be edited), and may gain steps after them.
     */
    async putSteps(id: string, steps: readonly StepInput[]): Promise<SequenceView> {
        const context = this.current();
        return this.rls.withWorkspace(async (tx) => {
            const sequence = await find(tx, id, context);
            if (sequence.status === 'archived') throw new StateConflict('an archived sequence is read-only');
            await validateSteps(tx, steps);
            const existing = [...sequence.steps].sort((a, b) => a.position - b.position);
            if (sequence.status !== 'draft') {
                const kept = existing.every((s, i) => steps[i]?.id === s.id && steps[i]?.kind === s.kind);
                if (!kept || steps.slice(existing.length).some((s) => s.id)) {
                    throw new ValidationFailed('a sequence that has run keeps its steps in order', [
                        {
                            path: 'steps',
                            message:
                                'keep the existing steps first, in order (you may edit them) and add new ones after; to restructure, duplicate the sequence',
                        },
                    ]);
                }
                for (const [i, s] of existing.entries()) {
                    await tx.sequenceStep.update({ where: { id: s.id }, data: stepData(steps[i]!) });
                }
                for (const [i, s] of steps.slice(existing.length).entries()) {
                    await tx.sequenceStep.create({
                        data: {
                            workspaceId: context.workspaceId,
                            sequenceId: id,
                            position: existing.length + i,
                            kind: s.kind,
                            ...stepData(s),
                        },
                    });
                }
            } else {
                await tx.sequenceStep.deleteMany({ where: { sequenceId: id } });
                for (const [position, s] of steps.entries()) {
                    await tx.sequenceStep.create({
                        data: {
                            workspaceId: context.workspaceId,
                            sequenceId: id,
                            position,
                            kind: s.kind,
                            ...stepData(s),
                        },
                    });
                }
            }
            await tx.sequence.update({ where: { id }, data: { updatedAt: new Date() } });
            await this.announce(tx, context, 'sequence.updated', id, {
                steps: { from: existing.length, to: steps.length },
            });
            return view(await find(tx, id, context), (await countsFor(tx, [id])).get(id));
        });
    }

    /**
     * Draft or paused → active. Refused unless it has an email step, every email step's template is a
     * live outreach template, and the workspace has the postal address outreach mail must carry
     * (FR-CRMS-12). Resuming a paused sequence gives every due enrolment its job again.
     */
    async activate(id: string): Promise<SequenceView> {
        const result = await this.transition(id, ['draft', 'paused'], 'active', async (tx, row) => {
            const emails = row.steps.filter((s) => s.kind === 'email');
            if (emails.length === 0) {
                throw new ApiException(422, 'unprocessable', 'a sequence needs at least one email step to run');
            }
            const templates = await tx.emailTemplate.findMany({
                where: { id: { in: emails.map((s) => s.templateId!) }, deletedAt: null, kind: 'outreach' },
                select: { id: true },
            });
            if (templates.length !== new Set(emails.map((s) => s.templateId)).size) {
                throw new ApiException(422, 'unprocessable', 'every email step needs a live outreach template');
            }
            const settings = await readMailSettings(tx);
            if (!settings.postalAddress) {
                throw new ApiException(
                    422,
                    'unprocessable',
                    'set the workspace postal address (Settings → Mail) first: outreach mail must carry it',
                );
            }
        });
        if (result.from === 'paused') await this.requeueDue(id);
        return result.view;
    }

    async pause(id: string): Promise<SequenceView> {
        return (await this.transition(id, ['active'], 'paused')).view;
    }

    async resume(id: string): Promise<SequenceView> {
        return this.activate(id);
    }

    /** Any → archived: read-only; its active and held enrolments stop (`sequence_archived`). */
    async archive(id: string): Promise<SequenceView> {
        const result = await this.transition(id, ['draft', 'active', 'paused'], 'archived');
        const ws = this.current().workspaceId;
        const open = await this.rls.withWorkspace((tx) =>
            tx.sequenceEnrolment.findMany({
                where: { sequenceId: id, status: { in: ['active', 'held'] } },
                select: { id: true },
            }),
        );
        for (const e of open) await this.runner.stop(ws, e.id, 'sequence_archived');
        return this.get(id).catch(() => result.view);
    }

    private async transition(
        id: string,
        from: readonly SequenceRow['status'][],
        to: SequenceRow['status'],
        check?: (tx: WorkspaceClient, row: SequenceRow) => Promise<void>,
    ): Promise<{ view: SequenceView; from: SequenceRow['status'] }> {
        const context = this.current();
        return this.rls.withWorkspace(async (tx) => {
            const row = await find(tx, id, context);
            if (row.status === to) return { view: view(row, (await countsFor(tx, [id])).get(id)), from: row.status };
            if (!from.includes(row.status)) throw new StateConflict(`a ${row.status} sequence cannot become ${to}`);
            if (check) await check(tx, row);
            const changed = await tx.sequence.updateMany({
                where: { id, status: row.status },
                data: { status: to, ...(to === 'archived' ? { archivedAt: new Date() } : {}) },
            });
            if (changed.count === 0) throw new StateConflict('the sequence changed meanwhile; try again');
            await this.announce(tx, context, to === 'archived' ? 'sequence.archived' : 'sequence.updated', id, {
                status: { from: row.status, to },
            });
            return {
                view: view(await find(tx, id, context), (await countsFor(tx, [id])).get(id)),
                from: row.status,
            };
        });
    }

    private async requeueDue(id: string): Promise<void> {
        const ws = this.current().workspaceId;
        const due = await this.rls.withWorkspace((tx) =>
            tx.sequenceEnrolment.findMany({
                where: { sequenceId: id, status: 'active', nextRunAt: { not: null } },
                select: { id: true, nextRunAt: true },
            }),
        );
        for (const e of due) await this.runner.enqueue(ws, e.id, e.nextRunAt!);
    }

    private announce(
        tx: WorkspaceClient,
        context: WorkspaceRunContext,
        type: 'sequence.created' | 'sequence.updated' | 'sequence.archived',
        recordId: string,
        diff?: Record<string, { from: unknown; to: unknown }>,
    ): Promise<void> {
        return this.events.record(tx, {
            type,
            object: 'sequence',
            workspaceId: context.workspaceId,
            actor: actorOf(context),
            occurredAt: new Date().toISOString(),
            recordId,
            ...(diff ? { diff } : {}),
        } as DomainEvent);
    }

    private current(): WorkspaceRunContext {
        const context = this.context.get();
        if (!context) throw new Error('SequencesService is used inside a workspace scope');
        return context;
    }
}

/** The sequence, if the caller may see it (#192): one they may not is not found, never forbidden. */
async function find(tx: WorkspaceClient, id: string, context: WorkspaceRunContext): Promise<SequenceRow> {
    const row = await tx.sequence.findFirst({
        where: { id, ...(await sequenceVisibleWhere(tx, context)) },
        include: { steps: true },
    });
    if (!row) throw new NotFoundException('sequence not found');
    return row;
}

async function assertPipeline(tx: WorkspaceClient, id: string): Promise<void> {
    if (!(await tx.pipeline.findUnique({ where: { id }, select: { id: true } }))) {
        throw new ValidationFailed('no such pipeline', [
            { path: 'pipelineId', message: 'not a pipeline in this workspace' },
        ]);
    }
}

function assertZone(zone: string): void {
    if (!isTimeZone(zone)) {
        throw new ValidationFailed('not a time zone', [
            { path: 'timeZone', message: 'an IANA zone, e.g. America/New_York' },
        ]);
    }
}

/** Email steps need a live outreach template; a reply in thread needs an email step before it. */
async function validateSteps(tx: WorkspaceClient, steps: readonly StepInput[]): Promise<void> {
    const templateIds = steps.flatMap((s) => (s.kind === 'email' ? [s.templateId] : []));
    const live = new Map(
        (
            await tx.emailTemplate.findMany({
                where: { id: { in: templateIds }, deletedAt: null },
                select: { id: true, kind: true },
            })
        ).map((t) => [t.id, t.kind]),
    );
    const problems: { path: string; message: string }[] = [];
    let emailSeen = false;
    for (const [i, s] of steps.entries()) {
        if (s.kind !== 'email') continue;
        const kind = live.get(s.templateId);
        if (!kind) problems.push({ path: `steps.${i}.templateId`, message: 'no such template' });
        else if (kind !== 'outreach')
            problems.push({ path: `steps.${i}.templateId`, message: 'a sequence sends outreach templates only' });
        if (s.replyInThread && !emailSeen) {
            problems.push({
                path: `steps.${i}.replyInThread`,
                message: 'a reply in thread needs an email step before it',
            });
        }
        emailSeen = true;
    }
    if (problems.length > 0) throw new ApiException(422, 'unprocessable', 'some steps cannot be used', problems);
}

function stepData(s: StepInput) {
    const none = { templateId: null, replyInThread: false, waitDays: null, businessDays: true, taskTitle: null };
    switch (s.kind) {
        case 'email':
            return { ...none, templateId: s.templateId, replyInThread: s.replyInThread };
        case 'wait':
            return { ...none, waitDays: s.waitDays, businessDays: s.businessDays };
        case 'task':
            return { ...none, taskTitle: s.taskTitle };
    }
}

async function countsFor(tx: WorkspaceClient, ids: readonly string[]): Promise<Map<string, SequenceCounts>> {
    const rows = await tx.sequenceEnrolment.groupBy({
        by: ['sequenceId', 'status'],
        where: { sequenceId: { in: [...ids] } },
        _count: { _all: true },
    });
    const out = new Map<string, SequenceCounts>();
    for (const r of rows) {
        const c = out.get(r.sequenceId) ?? { enrolled: 0, active: 0, held: 0, finished: 0, stopped: 0 };
        c[r.status] += r._count._all;
        c.enrolled += r._count._all;
        out.set(r.sequenceId, c);
    }
    return out;
}

export function view(
    row: SequenceRow,
    counts: SequenceCounts | undefined,
    tracking: ReadonlyMap<string, TrackingCounts> = new Map(),
): SequenceView {
    return {
        id: row.id,
        name: row.name,
        status: row.status,
        pipelineId: row.pipelineId,
        stopOnPipelineExit: row.stopOnPipelineExit,
        timeZone: row.timeZone,
        window: { startMinute: row.windowStartMinute, endMinute: row.windowEndMinute, days: row.windowDays },
        steps: [...row.steps]
            .sort((a, b) => a.position - b.position)
            .map((s) => ({
                id: s.id,
                position: s.position,
                kind: s.kind,
                templateId: s.templateId,
                replyInThread: s.replyInThread,
                waitDays: s.waitDays,
                businessDays: s.businessDays,
                taskTitle: s.taskTitle,
                tracking: tracking.get(s.id) ?? { ...NO_TRACKING_COUNTS },
            })),
        counts: counts ?? { enrolled: 0, active: 0, held: 0, finished: 0, stopped: 0 },
        createdBy: row.createdBy as unknown as Actor,
        ownerMemberId: row.ownerMemberId,
        visibility: row.visibility,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
    };
}

import { Injectable, NotFoundException } from '@nestjs/common';
import type { Actor, DomainEvent, EnrolmentBatchResult, EnrolmentView } from '@bylinecrm/shared';
import type { Prisma, SequenceEnrolment } from '@prisma/client';
import { DomainEvents } from '../events/domain-events.service';
import { StateConflict, ValidationFailed } from '../infra/errors/api-errors';
import { RlsPrismaService, type WorkspaceClient } from '../infra/rls-prisma.service';
import { WorkspaceContext, type WorkspaceRunContext } from '../infra/workspace-context';
import { actorOf } from '../records/actor';
import { EnrolmentScreen } from './enrolment-screen';
import { SequenceRunner } from './sequence-runner';

/**
 * Enrolments (P3-3): putting people in a sequence through the one screen (`EnrolmentScreen`), idempotent
 * per (sequence, person) — a second enrol is reported skipped, never a second row — and the actions on
 * one enrolment: stop by hand, re-enrol from step 1 (explicit, naming the earlier stop), resume a held one.
 */
@Injectable()
export class EnrolmentsService {
    constructor(
        private readonly rls: RlsPrismaService,
        private readonly context: WorkspaceContext,
        private readonly events: DomainEvents,
        private readonly screen: EnrolmentScreen,
        private readonly runner: SequenceRunner,
    ) {}

    /** What an enrol would do now — the same decision, nothing written. */
    async preview(sequenceId: string, personIds: readonly string[]): Promise<EnrolmentBatchResult> {
        return this.decide(sequenceId, personIds);
    }

    async enrol(sequenceId: string, personIds: readonly string[], dealId?: string): Promise<EnrolmentBatchResult> {
        const context = this.current();
        const decided = await this.decide(sequenceId, personIds, true);
        if (decided.enrolled.length === 0) return decided;
        const now = new Date();
        const inserted = await this.rls.withWorkspace(async (tx) => {
            if (dealId && !(await tx.opportunity.findFirst({ where: { id: dealId, deletedAt: null } }))) {
                throw new ValidationFailed('no such deal', [
                    { path: 'dealId', message: 'not a deal in this workspace' },
                ]);
            }
            const rows = await tx.sequenceEnrolment.createManyAndReturn({
                data: decided.enrolled.map((personId) => ({
                    workspaceId: context.workspaceId,
                    sequenceId,
                    personId,
                    dealId: dealId ?? null,
                    nextRunAt: now,
                    enrolledBy: actorOf(context) as unknown as Prisma.InputJsonValue,
                })),
                skipDuplicates: true,
            });
            await this.events.recordAll(
                tx,
                rows.map((r) => event(context, r, 'enrolment.created')),
            );
            for (const r of rows) this.runner.enqueueAfterCommit(context.workspaceId, r.id, now);
            return rows.map((r) => r.personId);
        });
        // A person enrolled by another request between the decision and the insert is skipped, not doubled.
        const raced = decided.enrolled.filter((id) => !inserted.includes(id));
        return { enrolled: inserted, skipped: [...decided.skipped, ...raced], refused: decided.refused };
    }

    async list(sequenceId: string): Promise<EnrolmentView[]> {
        return this.rls.withWorkspace(async (tx) => {
            await sequenceOrThrow(tx, sequenceId);
            return (
                await tx.sequenceEnrolment.findMany({ where: { sequenceId }, orderBy: { enrolledAt: 'desc' } })
            ).map(view);
        });
    }

    /** A person's enrolments, for their record page; `404` when the person is not visible. */
    async forPerson(personId: string): Promise<EnrolmentView[]> {
        return this.rls.withWorkspace(async (tx) => {
            if (!(await tx.person.findFirst({ where: { id: personId, deletedAt: null }, select: { id: true } }))) {
                throw new NotFoundException('person not found');
            }
            return (await tx.sequenceEnrolment.findMany({ where: { personId }, orderBy: { enrolledAt: 'desc' } })).map(
                view,
            );
        });
    }

    async stop(id: string, note?: string): Promise<EnrolmentView> {
        const row = await this.find(id);
        if (row.status !== 'active' && row.status !== 'held') throw new StateConflict(`the enrolment is ${row.status}`);
        await this.runner.stop(this.current().workspaceId, id, 'manual', note);
        return view(await this.find(id));
    }

    /** Stopped or finished → active from step 1, explicitly; the event names the earlier stop. */
    async reenrol(id: string): Promise<EnrolmentView> {
        const context = this.current();
        const now = new Date();
        return this.rls.withWorkspace(async (tx) => {
            const row = await findIn(tx, id);
            if (row.status !== 'stopped' && row.status !== 'finished') {
                throw new StateConflict(
                    `the enrolment is ${row.status}; only a stopped or finished one is re-enrolled`,
                );
            }
            const changed = await tx.sequenceEnrolment.updateMany({
                where: { id, status: row.status },
                data: {
                    status: 'active',
                    stepIndex: 0,
                    nextRunAt: now,
                    waitingOutboundId: null,
                    heldReason: null,
                    stopReason: null,
                    stopDetail: null,
                    stoppedAt: null,
                    finishedAt: null,
                    enrolledAt: now,
                    enrolledBy: actorOf(context) as unknown as Prisma.InputJsonValue,
                },
            });
            if (changed.count === 0) throw new StateConflict('the enrolment changed meanwhile; try again');
            await this.events.record(
                tx,
                event(
                    context,
                    row,
                    'enrolment.created',
                    row.stopReason ? `re-enrolled after ${row.stopReason}` : 're-enrolled',
                ),
            );
            this.runner.enqueueAfterCommit(context.workspaceId, id, now);
            return view(await findIn(tx, id));
        });
    }

    /** Held → active: its step runs again now (after the data that held it was fixed). */
    async resume(id: string): Promise<EnrolmentView> {
        const context = this.current();
        const now = new Date();
        return this.rls.withWorkspace(async (tx) => {
            const changed = await tx.sequenceEnrolment.updateMany({
                where: { id, status: 'held' },
                data: { status: 'active', heldReason: null, nextRunAt: now },
            });
            if (changed.count === 0) {
                const row = await findIn(tx, id);
                throw new StateConflict(`the enrolment is ${row.status}; only a held one is resumed`);
            }
            this.runner.enqueueAfterCommit(context.workspaceId, id, now);
            return view(await findIn(tx, id));
        });
    }

    /**
     * The decision: the people already in the sequence are skipped (whatever their state); the rest go
     * through the screen. `forEnrol`: the sequence must be one that runs (active or paused).
     */
    private async decide(
        sequenceId: string,
        personIds: readonly string[],
        forEnrol = false,
    ): Promise<EnrolmentBatchResult> {
        const context = this.current();
        const unique = [...new Set(personIds)];
        const existing = await this.rls.withWorkspace(async (tx) => {
            const sequence = await sequenceOrThrow(tx, sequenceId);
            if (forEnrol && sequence.status !== 'active' && sequence.status !== 'paused') {
                throw new StateConflict(`a ${sequence.status} sequence takes no enrolments; activate it first`);
            }
            return new Set(
                (
                    await tx.sequenceEnrolment.findMany({
                        where: { sequenceId, personId: { in: unique } },
                        select: { personId: true },
                    })
                ).map((e) => e.personId),
            );
        });
        const skipped = unique.filter((id) => existing.has(id));
        const { eligible, refused } = await this.screen.screen(
            context.workspaceId,
            unique.filter((id) => !existing.has(id)),
        );
        return { enrolled: eligible.map((e) => e.personId), skipped, refused };
    }

    private find(id: string): Promise<SequenceEnrolment> {
        return this.rls.withWorkspace((tx) => findIn(tx, id));
    }

    private current(): WorkspaceRunContext {
        const context = this.context.get();
        if (!context) throw new Error('EnrolmentsService is used inside a workspace scope');
        return context;
    }
}

async function sequenceOrThrow(tx: WorkspaceClient, id: string) {
    const sequence = await tx.sequence.findUnique({ where: { id }, select: { id: true, status: true } });
    if (!sequence) throw new NotFoundException('sequence not found');
    return sequence;
}

async function findIn(tx: WorkspaceClient, id: string): Promise<SequenceEnrolment> {
    const row = await tx.sequenceEnrolment.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('enrolment not found');
    return row;
}

function event(
    context: WorkspaceRunContext,
    row: SequenceEnrolment,
    type: 'enrolment.created',
    detail?: string,
): DomainEvent {
    return {
        type,
        object: 'enrolment',
        workspaceId: context.workspaceId,
        actor: actorOf(context),
        occurredAt: new Date().toISOString(),
        recordId: row.id,
        related: [{ type: 'person', id: row.personId }],
        enrolment: { sequenceId: row.sequenceId, personId: row.personId, stepIndex: 0, ...(detail ? { detail } : {}) },
    } as DomainEvent;
}

export function view(row: SequenceEnrolment): EnrolmentView {
    return {
        id: row.id,
        sequenceId: row.sequenceId,
        personId: row.personId,
        dealId: row.dealId,
        status: row.status,
        stepIndex: row.stepIndex,
        nextRunAt: row.nextRunAt?.toISOString() ?? null,
        waitingOutboundId: row.waitingOutboundId,
        heldReason: row.heldReason,
        stopReason: row.stopReason,
        stopDetail: row.stopDetail,
        enrolledBy: row.enrolledBy as unknown as Actor,
        enrolledAt: row.enrolledAt.toISOString(),
        finishedAt: row.finishedAt?.toISOString() ?? null,
        stoppedAt: row.stoppedAt?.toISOString() ?? null,
    };
}

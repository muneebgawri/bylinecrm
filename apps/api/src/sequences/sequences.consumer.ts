import { Injectable } from '@nestjs/common';
import type { DomainEvent, EnrolmentStopReason, SuppressionReason } from '@bylinecrm/shared';
import { OutboxConsumerOf, type DeliveredEvent, type OutboxConsumer } from '../events/outbox-consumer';
import { RlsPrismaService } from '../infra/rls-prisma.service';
import { SequenceRunner } from './sequence-runner';

const SUPPRESSION_STOP: Readonly<Record<SuppressionReason, EnrolmentStopReason>> = {
    unsubscribe: 'unsubscribe',
    complaint: 'complaint',
    hard_bounce: 'bounce',
    manual: 'suppressed',
};

/**
 * What a sequence reacts to as it happens (P3-3) — the fast path; the runner's check before every step
 * is the backstop. A step's send coming back (`email.sent`, `email.failed`, `email.cancelled`) advances,
 * reschedules, holds or stops its enrolment; a reply, a suppression, a deal leaving its sequence's
 * pipeline and a deleted person stop the enrolments they concern. Every step is idempotent, so a
 * redelivered event changes nothing.
 */
@Injectable()
@OutboxConsumerOf('sequences')
export class SequencesConsumer implements OutboxConsumer {
    constructor(
        private readonly runner: SequenceRunner,
        private readonly rls: RlsPrismaService,
    ) {}

    accepts(event: DomainEvent): boolean {
        return [
            'email.sent',
            'email.failed',
            'email.cancelled',
            'email.replied',
            'suppression.added',
            'deal.stage_changed',
            'deal.won',
            'deal.lost',
            'opportunity.deleted',
            'person.deleted',
        ].includes(event.type);
    }

    async consume({ event }: DeliveredEvent): Promise<void> {
        const ws = event.workspaceId;
        switch (event.type) {
            case 'email.sent': {
                const sends = await this.rls.withWorkspace(ws, (tx) =>
                    tx.mailOutbound.findMany({
                        where: { mailMessageId: event.recordId, sequenceEnrolmentId: { not: null } },
                        select: { id: true },
                    }),
                );
                for (const s of sends) await this.runner.onOutcome(ws, s.id);
                return;
            }
            case 'email.failed':
            case 'email.cancelled':
                await this.runner.onOutcome(ws, event.recordId);
                return;
            case 'email.replied':
                await this.stopFor(ws, { personId: { in: event.reply?.personIds ?? [] } }, 'reply');
                return;
            case 'suppression.added': {
                const s = event.suppression;
                if (!s) return;
                const people = await this.rls.withWorkspace(ws, (tx) =>
                    tx.person.findMany({ where: { emailPrimary: s.address }, select: { id: true } }),
                );
                await this.stopFor(ws, { personId: { in: people.map((p) => p.id) } }, SUPPRESSION_STOP[s.reason]);
                return;
            }
            case 'person.deleted':
                await this.stopFor(ws, { personId: event.recordId }, 'person_deleted');
                return;
            default: {
                // A deal moved, closed or was deleted: enrolments on it whose sequence stops on leaving the pipeline.
                const enrolments = await this.rls.withWorkspace(ws, (tx) =>
                    tx.sequenceEnrolment.findMany({
                        where: {
                            dealId: event.recordId,
                            status: { in: ['active', 'held'] },
                            sequence: { stopOnPipelineExit: true, pipelineId: { not: null } },
                        },
                        select: {
                            id: true,
                            sequence: { select: { pipelineId: true } },
                            deal: { select: { pipelineId: true, deletedAt: true, stage: { select: { kind: true } } } },
                        },
                    }),
                );
                for (const e of enrolments) {
                    const d = e.deal;
                    const left = !d || d.deletedAt || d.pipelineId !== e.sequence.pipelineId || d.stage.kind !== 'open';
                    if (left) await this.runner.stop(ws, e.id, 'pipeline_exit');
                }
            }
        }
    }

    private async stopFor(
        workspaceId: string,
        where: { personId: string | { in: string[] } },
        reason: EnrolmentStopReason,
    ): Promise<void> {
        const enrolments = await this.rls.withWorkspace(workspaceId, (tx) =>
            tx.sequenceEnrolment.findMany({
                where: { ...where, status: { in: ['active', 'held'] } },
                select: { id: true },
            }),
        );
        for (const e of enrolments) await this.runner.stop(workspaceId, e.id, reason);
    }
}

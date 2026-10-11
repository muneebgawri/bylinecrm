import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { PrismaService } from '../infra/prisma.service';
import { SequenceRunner, stepJobId, type SequenceStepJob } from './sequence-runner';
import {
    SEQUENCE_OUTCOME_GRACE_MS,
    SEQUENCE_STEP_QUEUE,
    SEQUENCE_SWEEP_BATCH,
    SEQUENCE_SWEEP_HORIZON_MS,
} from './sequences.constants';

export interface SequenceSweepResult {
    /** Due steps that had no live job and were given one. */
    requeued: number;
    /** Step sends that had finished while their enrolment still waited: their outcome, delivered again. */
    outcomes: number;
}

/**
 * The backstop under the step jobs and the outcome events (P3-3) — the send sweep's pattern:
 *
 * - an active enrolment due before the next two passes whose job is gone (Redis lost it, or was down
 *   when it was written) is given its job again — the job id is the (enrolment, time), so a pass never
 *   adds a second one;
 * - an enrolment still waiting on a send that has finished (sent, failed, cancelled) longer than a grace
 *   period missed its outcome event: the outcome is applied now.
 *
 * Runs as the owner: it spans every workspace and is not a request. Running it twice does nothing twice.
 */
@Injectable()
export class SequenceSweep {
    private readonly logger = new Logger(SequenceSweep.name);

    constructor(
        private readonly ownerPrisma: PrismaService,
        private readonly runner: SequenceRunner,
        @InjectQueue(SEQUENCE_STEP_QUEUE) private readonly queue: Queue<SequenceStepJob>,
    ) {}

    async run(now = Date.now()): Promise<SequenceSweepResult> {
        const due = await this.ownerPrisma.sequenceEnrolment.findMany({
            where: {
                status: 'active',
                nextRunAt: { lte: new Date(now + SEQUENCE_SWEEP_HORIZON_MS) },
                sequence: { status: 'active' },
            },
            select: { id: true, workspaceId: true, nextRunAt: true },
            orderBy: { nextRunAt: 'asc' },
            take: SEQUENCE_SWEEP_BATCH,
        });
        let requeued = 0;
        for (const e of due) {
            if (await this.queue.getJob(stepJobId(e.id, e.nextRunAt!))) continue;
            await this.runner.enqueue(e.workspaceId, e.id, e.nextRunAt!);
            requeued += 1;
        }

        const stranded = await this.ownerPrisma.sequenceEnrolment.findMany({
            where: {
                status: 'active',
                waitingSend: {
                    status: { in: ['sent', 'failed', 'cancelled'] },
                    updatedAt: { lt: new Date(now - SEQUENCE_OUTCOME_GRACE_MS) },
                },
            },
            select: { workspaceId: true, waitingOutboundId: true },
            take: SEQUENCE_SWEEP_BATCH,
        });
        for (const e of stranded) await this.runner.onOutcome(e.workspaceId, e.waitingOutboundId!);

        if (requeued + stranded.length > 0) {
            this.logger.warn(`sweep: ${requeued} step jobs re-added, ${stranded.length} step outcomes re-applied`);
        }
        return { requeued, outcomes: stranded.length };
    }
}

import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { PrismaService } from '../infra/prisma.service';
import { RedisService } from '../infra/redis.service';
import { RedisSweepCursors, keysetAfter, resumableSweep } from '../infra/resumable-sweep';
import { SequenceRunner, stepJobId, type SequenceStepJob } from './sequence-runner';
import {
    SEQUENCE_OUTCOME_GRACE_MS,
    SEQUENCE_STEP_QUEUE,
    SEQUENCE_SWEEP_BATCH,
    SEQUENCE_SWEEP_HORIZON_MS,
    SEQUENCE_SWEEP_MAX_ROWS_PER_PASS,
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
 * Both scans read in keyset order and resume where the last pass stopped (#97), so rows that are fine
 * never hide one that is not. Runs as the owner: it spans every workspace and is not a request.
 * Running it twice does nothing twice.
 */
@Injectable()
export class SequenceSweep {
    private readonly logger = new Logger(SequenceSweep.name);
    private readonly cursors: RedisSweepCursors;

    constructor(
        private readonly ownerPrisma: PrismaService,
        redis: RedisService,
        private readonly runner: SequenceRunner,
        @InjectQueue(SEQUENCE_STEP_QUEUE) private readonly queue: Queue<SequenceStepJob>,
    ) {
        this.cursors = new RedisSweepCursors(redis);
    }

    async run(now = Date.now()): Promise<SequenceSweepResult> {
        let requeued = 0;
        await resumableSweep({
            name: 'sequence-steps',
            cursors: this.cursors,
            pageSize: SEQUENCE_SWEEP_BATCH,
            maxRowsPerPass: SEQUENCE_SWEEP_MAX_ROWS_PER_PASS,
            page: (after, take) =>
                this.ownerPrisma.sequenceEnrolment.findMany({
                    where: {
                        status: 'active',
                        nextRunAt: { lte: new Date(now + SEQUENCE_SWEEP_HORIZON_MS) },
                        sequence: { status: 'active' },
                        ...keysetAfter('nextRunAt', after),
                    },
                    select: { id: true, workspaceId: true, nextRunAt: true },
                    orderBy: [{ nextRunAt: 'asc' }, { id: 'asc' }],
                    take,
                }),
            position: (e) => ({ at: e.nextRunAt!.toISOString(), id: e.id }),
            visit: async (e) => {
                if (await this.queue.getJob(stepJobId(e.id, e.nextRunAt!))) return;
                await this.runner.enqueue(e.workspaceId, e.id, e.nextRunAt!);
                requeued += 1;
            },
        });

        let outcomes = 0;
        await resumableSweep({
            name: 'sequence-outcomes',
            cursors: this.cursors,
            pageSize: SEQUENCE_SWEEP_BATCH,
            maxRowsPerPass: SEQUENCE_SWEEP_MAX_ROWS_PER_PASS,
            page: (after, take) =>
                this.ownerPrisma.sequenceEnrolment.findMany({
                    where: {
                        status: 'active',
                        waitingSend: {
                            status: { in: ['sent', 'failed', 'cancelled'] },
                            updatedAt: { lt: new Date(now - SEQUENCE_OUTCOME_GRACE_MS) },
                        },
                        ...keysetAfter('createdAt', after),
                    },
                    select: { id: true, createdAt: true, workspaceId: true, waitingOutboundId: true },
                    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
                    take,
                }),
            position: (e) => ({ at: e.createdAt.toISOString(), id: e.id }),
            visit: async (e) => {
                await this.runner.onOutcome(e.workspaceId, e.waitingOutboundId!);
                outcomes += 1;
            },
        });

        if (requeued + outcomes > 0) {
            this.logger.warn(`sweep: ${requeued} step jobs re-added, ${outcomes} step outcomes re-applied`);
        }
        return { requeued, outcomes };
    }
}

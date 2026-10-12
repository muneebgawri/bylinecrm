import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { PrismaService } from '../infra/prisma.service';
import { RedisService } from '../infra/redis.service';
import { RedisSweepCursors, keysetAfter, resumableSweep } from '../infra/resumable-sweep';
import {
    MAIL_SEND_QUEUE,
    MAIL_SEND_SWEEP_BATCH,
    MAIL_SEND_SWEEP_GRACE_MS,
    MAIL_SEND_SWEEP_HORIZON_MS,
    MAIL_SEND_SWEEP_MAX_ROWS_PER_PASS,
} from './mail-send.constants';
import type { MailSendJob } from './mail-send.workers';

/** What one pass did, for the log and the tests. */
export interface SendSweepResult {
    /** Sends that had no live job and were given one. */
    requeued: number;
}

/**
 * Finds sends whose job was lost (Redis lost it, or was down when the send was written) and gives
 * them one again — P1-5's stranded-delivery sweep, for mail:
 *
 * - `queued` older than a grace period with no job (the add failed);
 * - `scheduled` due before the next two passes with no job — a send due later is looked at when
 *   it comes due, so a pass never scans every future send. One already overdue gets a job that
 *   runs at once; at its time the job decides whether it is still worth sending (`stale`).
 *
 * The job id is the send's, so a send that has a live job is never given a second one, and running
 * the sweep twice enqueues nothing twice. Candidates are read in `(createdAt, id)` order and a pass
 * resumes where the last one stopped (#97). Runs as the owner: it spans every workspace and is not a
 * request.
 */
@Injectable()
export class MailSendSweep {
    private readonly logger = new Logger(MailSendSweep.name);
    private readonly cursors: RedisSweepCursors;

    constructor(
        private readonly ownerPrisma: PrismaService,
        redis: RedisService,
        @InjectQueue(MAIL_SEND_QUEUE) private readonly queue: Queue<MailSendJob>,
    ) {
        this.cursors = new RedisSweepCursors(redis);
    }

    async run(now = Date.now()): Promise<SendSweepResult> {
        let requeued = 0;
        await resumableSweep({
            name: 'mail-sends',
            cursors: this.cursors,
            pageSize: MAIL_SEND_SWEEP_BATCH,
            maxRowsPerPass: MAIL_SEND_SWEEP_MAX_ROWS_PER_PASS,
            page: (after, take) =>
                this.ownerPrisma.mailOutbound.findMany({
                    where: {
                        AND: [
                            {
                                OR: [
                                    { status: 'queued', createdAt: { lt: new Date(now - MAIL_SEND_SWEEP_GRACE_MS) } },
                                    {
                                        status: 'scheduled',
                                        sendAt: { lte: new Date(now + MAIL_SEND_SWEEP_HORIZON_MS) },
                                    },
                                ],
                            },
                            keysetAfter('createdAt', after),
                        ],
                    },
                    select: { id: true, workspaceId: true, status: true, sendAt: true, createdAt: true },
                    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
                    take,
                }),
            position: (row) => ({ at: row.createdAt.toISOString(), id: row.id }),
            visit: async (row) => {
                if (await this.queue.getJob(row.id)) return;
                const delay = row.status === 'scheduled' && row.sendAt ? Math.max(0, row.sendAt.getTime() - now) : 0;
                await this.queue.add(
                    'send',
                    { workspaceId: row.workspaceId, messageId: row.id },
                    { jobId: row.id, delay },
                );
                requeued += 1;
            },
        });
        if (requeued > 0) this.logger.warn(`sweep: re-enqueued ${requeued} sends whose job was gone`);
        return { requeued };
    }
}

import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { REGION_LABELS, regionOfCountry } from '@bylinecrm/shared';
import type { DomainEvent, Emails, EnrolmentEventPayload, EnrolmentStopReason, RegionCode } from '@bylinecrm/shared';
import type { Prisma, SuppressionReason } from '@prisma/client';
import type { Queue } from 'bullmq';
import { DomainEvents } from '../events/domain-events.service';
import { RlsPrismaService, type WorkspaceClient } from '../infra/rls-prisma.service';
import { afterCommit } from '../infra/transaction-scope';
import { WorkspaceContext } from '../infra/workspace-context';
import { MailSendService } from '../mail-send/mail-send.service';
import { SendingPoolService } from '../sending-pool/sending-pool.service';
import { SuppressionService } from '../suppression/suppression.service';
import { RenderService } from '../templates/render.service';
import { TemplatesService } from '../templates/templates.service';
import { EmailVerificationService } from '../verification/email-verification.service';
import { inferCountry } from './country';
import { ExclusionsService } from './exclusions.service';
import { RegionPolicyService } from './region-policy.service';
import { addWaitDays, nextWindowStart, zoneForCountry, type SendWindow } from './schedule';
import {
    RESCHEDULE_FAILURE_CODES,
    SEQUENCE_POOL_RETRY_MS,
    SEQUENCE_STEP_QUEUE,
    SEQUENCE_VERIFY_RETRY_MS,
} from './sequences.constants';

/** A step's job: which enrolment, and the `next_run_at` it was added for. */
export interface SequenceStepJob {
    workspaceId: string;
    enrolmentId: string;
    /** ISO; a job whose time no longer matches the enrolment's does nothing. */
    at: string;
}

/**
 * One job per (enrolment, time): a rescheduled step gets a new job; the old one finds its time changed.
 * (BullMQ reserves `:` in job ids.)
 */
export function stepJobId(enrolmentId: string, at: Date): string {
    return `${enrolmentId}.${at.getTime()}`;
}

export type RunOutcome =
    'skipped' | 'paused' | 'not_due' | 'stopped' | 'advanced' | 'finished' | 'scheduled' | 'rescheduled' | 'held';

/** A job may fire this early (Redis timers are not exact). */
const EARLY_TOLERANCE_MS = 1000;
/** A reply-in-thread step whose parent send is not stored yet waits this long for the next sync. */
const PARENT_WAIT_MS = 5 * 60_000;

type EnrolmentRow = Prisma.SequenceEnrolmentGetPayload<{
    include: {
        sequence: { include: { steps: true } };
        person: { select: { emails: true; country: true; deletedAt: true; company: { select: { address: true } } } };
    };
}>;

const SUPPRESSION_STOP: Readonly<Record<SuppressionReason, EnrolmentStopReason>> = {
    unsubscribe: 'unsubscribe',
    complaint: 'complaint',
    hard_bounce: 'bounce',
    manual: 'suppressed',
};

/**
 * Runs one enrolment's due step (P3-3, FR-CRMS-5). The enrolment row is the truth: a step runs only if
 * the enrolment is `active`, its sequence `active`, and its `next_run_at` due (and the job's). The stop
 * conditions are read from the database before every step — reply, suppression (unsubscribe, bounce,
 * complaint), exclusion (FR-CRMS-10), the deal leaving the pipeline, the person deleted. Then:
 *
 * - `wait` — advance; the next step runs `waitDays` later in the recipient's zone.
 * - `email` — the address verified again if its result has aged past the workspace's limit (FR-CRMS-14:
 *   not deliverable → stopped `invalid_address`; not verifiable → the step is tried later), then
 *   a pool mailbox (`pick`; the previous email step's for a reply in thread), the next open
 *   window instant in the recipient's zone spaced by `nextSendAt`, and the send scheduled in the same
 *   transaction as the enrolment's move to wait for it. No mailbox can send → rescheduled, never dropped.
 *   A variable the person has no value for → held, with the variables named (FR-CRMS-3).
 *
 * Every write is conditional on the row still being where this run read it, so two deliveries of one
 * job never both act. A step's send coming back (`onOutcome`) advances, reschedules, holds or stops it.
 */
@Injectable()
export class SequenceRunner {
    private readonly logger = new Logger(SequenceRunner.name);

    constructor(
        private readonly rls: RlsPrismaService,
        private readonly context: WorkspaceContext,
        private readonly events: DomainEvents,
        private readonly pool: SendingPoolService,
        private readonly send: MailSendService,
        private readonly suppressions: SuppressionService,
        private readonly exclusions: ExclusionsService,
        private readonly regions: RegionPolicyService,
        private readonly templates: TemplatesService,
        private readonly renderer: RenderService,
        private readonly verification: EmailVerificationService,
        @InjectQueue(SEQUENCE_STEP_QUEUE) private readonly queue: Queue<SequenceStepJob>,
    ) {}

    async run(workspaceId: string, enrolmentId: string, now = new Date(), expectedAt?: Date): Promise<RunOutcome> {
        const e = await this.load(workspaceId, enrolmentId);
        if (!e || e.status !== 'active' || e.nextRunAt === null) return 'skipped';
        if (expectedAt && e.nextRunAt.getTime() !== expectedAt.getTime()) return 'skipped';
        if (e.sequence.status !== 'active') return 'paused';
        if (e.nextRunAt.getTime() - now.getTime() > EARLY_TOLERANCE_MS) return 'not_due';

        const steps = [...e.sequence.steps].sort((a, b) => a.position - b.position);
        const step = steps[e.stepIndex];
        if (!step) return this.finish(e);

        const stop = await this.stopReason(e);
        if (stop) {
            await this.stop(workspaceId, e.id, stop.reason, stop.detail);
            return 'stopped';
        }

        const address = primaryAddress(e)!;
        const companyCountry = (e.person.company?.address as { country?: string | null } | null)?.country ?? null;
        const zone = zoneForCountry(
            inferCountry({ personCountry: e.person.country, companyCountry, email: address }).country,
            e.sequence.timeZone,
        );
        const window: SendWindow = {
            startMinute: e.sequence.windowStartMinute,
            endMinute: e.sequence.windowEndMinute,
            days: e.sequence.windowDays,
        };

        if (step.kind === 'wait') {
            const next = addWaitDays(now, step.waitDays!, step.businessDays, zone);
            const done = await this.rls.withWorkspace(workspaceId, async (tx) => {
                const moved = await claim(tx, e, { stepIndex: e.stepIndex + 1, nextRunAt: next });
                if (moved) {
                    await this.announce(tx, e, 'enrolment.step_completed', { stepIndex: e.stepIndex });
                    this.enqueueAfterCommit(workspaceId, e.id, next);
                }
                return moved;
            });
            return done ? 'advanced' : 'skipped';
        }

        // An email step: the address checked again (P3-5), the mailbox, then the time, then the send.
        const verdict = (await this.verification.check(workspaceId, [address])).get(address)!;
        if (verdict.result === 'invalid') {
            await this.stop(workspaceId, e.id, 'invalid_address', verdict.message);
            return 'stopped';
        }
        if (verdict.result === 'unknown') {
            return this.reschedule(workspaceId, e, new Date(now.getTime() + SEQUENCE_VERIFY_RETRY_MS), window, zone);
        }
        let mailboxId: string | null;
        let parentId: string | null = null;
        if (step.replyInThread) {
            const previous = await this.previousSend(workspaceId, e.id);
            if (!previous) {
                mailboxId = await this.pool.pick(workspaceId, now);
            } else if (!previous.mailMessageId) {
                return this.reschedule(workspaceId, e, new Date(now.getTime() + PARENT_WAIT_MS), window, zone);
            } else {
                mailboxId = previous.mailboxId;
                parentId = previous.mailMessageId;
            }
        } else {
            mailboxId = await this.pool.pick(workspaceId, now);
        }
        if (!mailboxId) {
            return this.reschedule(workspaceId, e, new Date(now.getTime() + SEQUENCE_POOL_RETRY_MS), window, zone);
        }

        // FR-CRMS-3: a variable this person has no value for holds their step, before anything is queued.
        const missing = await this.missingVariables(workspaceId, mailboxId, step.templateId!, e);
        if (missing.length > 0) {
            await this.hold(workspaceId, e.id, `missing ${missing.map((m) => `{{${m}}}`).join(', ')}`);
            return 'held';
        }

        let sendAt = await this.pool.nextSendAt(workspaceId, mailboxId, nextWindowStart(now, zone, window));
        sendAt = nextWindowStart(sendAt, zone, window);
        const scheduled = await this.rls.withWorkspace(workspaceId, async (tx) => {
            if (!(await claim(tx, e, { nextRunAt: null }))) return false;
            const outboundId = await this.send.scheduleOutreach(tx, {
                workspaceId,
                mailboxId,
                personId: e.personId,
                dealId: e.dealId,
                templateId: step.templateId!,
                replyToMessageId: parentId,
                sendAt,
                enrolmentId: e.id,
                stepId: step.id,
                senderMemberId: e.enrolledByMemberId,
            });
            await tx.sequenceEnrolment.update({ where: { id: e.id }, data: { waitingOutboundId: outboundId } });
            return true;
        });
        return scheduled ? 'scheduled' : 'skipped';
    }

    /**
     * A step's send came back (or the sweep found it finished): sent → advance; refused by the pool →
     * the same step again later; refused for the recipient's suppression → stop; any other failure, or a
     * member's cancel → held with the reason. Idempotent: an enrolment no longer waiting on this send is
     * left alone.
     */
    async onOutcome(workspaceId: string, outboundId: string, now = new Date()): Promise<void> {
        const found = await this.rls.withWorkspace(workspaceId, async (tx) => {
            const out = await tx.mailOutbound.findUnique({
                where: { id: outboundId },
                select: { status: true, lastError: true },
            });
            const enrolment = await tx.sequenceEnrolment.findFirst({
                where: { waitingOutboundId: outboundId, status: 'active' },
                select: { id: true },
            });
            return out && enrolment ? { out, enrolmentId: enrolment.id } : null;
        });
        if (!found) return;
        const e = await this.load(workspaceId, found.enrolmentId);
        if (!e || e.waitingOutboundId !== outboundId) return;
        const error = found.out.lastError as { code?: string; message?: string } | null;

        switch (found.out.status) {
            case 'sent': {
                const last = e.stepIndex + 1 >= e.sequence.steps.length;
                await this.rls.withWorkspace(workspaceId, async (tx) => {
                    const moved = await tx.sequenceEnrolment.updateMany({
                        where: { id: e.id, status: 'active', waitingOutboundId: outboundId },
                        data: last
                            ? {
                                  stepIndex: e.stepIndex + 1,
                                  waitingOutboundId: null,
                                  status: 'finished',
                                  finishedAt: now,
                              }
                            : { stepIndex: e.stepIndex + 1, waitingOutboundId: null, nextRunAt: now },
                    });
                    if (moved.count === 0) return;
                    await this.announce(tx, e, 'enrolment.step_completed', { stepIndex: e.stepIndex });
                    if (last) await this.announce(tx, e, 'enrolment.finished', { stepIndex: e.stepIndex + 1 });
                    else this.enqueueAfterCommit(workspaceId, e.id, now);
                });
                return;
            }
            case 'failed': {
                const code = error?.code ?? 'internal';
                if (RESCHEDULE_FAILURE_CODES.has(code)) {
                    const at = new Date(now.getTime() + SEQUENCE_POOL_RETRY_MS);
                    await this.rls.withWorkspace(workspaceId, async (tx) => {
                        const moved = await tx.sequenceEnrolment.updateMany({
                            where: { id: e.id, status: 'active', waitingOutboundId: outboundId },
                            data: { waitingOutboundId: null, nextRunAt: at },
                        });
                        if (moved.count === 1) this.enqueueAfterCommit(workspaceId, e.id, at);
                    });
                    return;
                }
                if (code === 'recipient.suppressed') {
                    await this.stop(workspaceId, e.id, 'suppressed', error?.message);
                    return;
                }
                await this.hold(workspaceId, e.id, error?.message ?? `the send failed (${code})`, outboundId);
                return;
            }
            case 'cancelled':
                await this.hold(workspaceId, e.id, 'send cancelled', outboundId);
                return;
            default:
                return;
        }
    }

    /**
     * Stops an enrolment (active or held) with `reason`: its pending step send is called off, and
     * `enrolment.stopped` recorded. Idempotent: an enrolment already ended is left alone.
     */
    async stop(
        workspaceId: string,
        enrolmentId: string,
        reason: EnrolmentStopReason,
        detail?: string | null,
    ): Promise<boolean> {
        return this.rls.withWorkspace(workspaceId, async (tx) => {
            const row = await tx.sequenceEnrolment.findUnique({ where: { id: enrolmentId } });
            if (!row || (row.status !== 'active' && row.status !== 'held')) return false;
            const moved = await tx.sequenceEnrolment.updateMany({
                where: { id: enrolmentId, status: { in: ['active', 'held'] } },
                data: {
                    status: 'stopped',
                    stopReason: reason,
                    stopDetail: detail ?? null,
                    stoppedAt: new Date(),
                    nextRunAt: null,
                    heldReason: null,
                    waitingOutboundId: null,
                },
            });
            if (moved.count === 0) return false;
            if (row.waitingOutboundId) await this.send.cancelForSequence(tx, workspaceId, row.waitingOutboundId);
            await this.announceRow(tx, row, 'enrolment.stopped', {
                stepIndex: row.stepIndex,
                reason,
                ...(detail ? { detail } : {}),
            });
            return true;
        });
    }

    /** Adds the job for a step due at `at`, after the caller's transaction commits. */
    enqueueAfterCommit(workspaceId: string, enrolmentId: string, at: Date): void {
        afterCommit('SequenceRunner.enqueue', () => {
            this.enqueue(workspaceId, enrolmentId, at).catch((error: unknown) =>
                // The sweep adds a due step's missing job; nothing is lost.
                this.logger.warn(
                    `enrolment ${enrolmentId}: job not added (${error instanceof Error ? error.message : String(error)}); the sweep will`,
                ),
            );
        });
    }

    async enqueue(workspaceId: string, enrolmentId: string, at: Date): Promise<void> {
        await this.queue.add(
            'step',
            { workspaceId, enrolmentId, at: at.toISOString() },
            { jobId: stepJobId(enrolmentId, at), delay: Math.max(0, at.getTime() - Date.now()) },
        );
    }

    /**
     * D-251: a person's country became known (or changed) after they were enrolled. Each of their running
     * enrolments whose region the workspace's policy now blocks is stopped (`region_blocked`); the check
     * before every step does the same, so a lost event only delays it to the next step.
     */
    async stopWhereRegionBlocked(workspaceId: string, personIds: readonly string[]): Promise<void> {
        if (personIds.length === 0) return;
        const rows = await this.rls.withWorkspace(workspaceId, async (tx) => ({
            policy: await this.regions.allowedIn(tx),
            enrolments: await tx.sequenceEnrolment.findMany({
                where: { personId: { in: [...personIds] }, status: { in: ['active', 'held'] } },
                select: {
                    id: true,
                    person: { select: { emails: true, country: true, company: { select: { address: true } } } },
                },
            }),
        }));
        for (const e of rows.enrolments) {
            const address = primaryAddress(e);
            if (!address) continue;
            const blocked = blockedRegion(e.person, address, rows.policy);
            if (blocked) await this.stop(workspaceId, e.id, 'region_blocked', blocked);
        }
    }

    // ── Internals ────────────────────────────────────────────────────────────────────────────

    private load(workspaceId: string, id: string): Promise<EnrolmentRow | null> {
        return this.rls.withWorkspace(workspaceId, (tx) =>
            tx.sequenceEnrolment.findUnique({
                where: { id },
                include: {
                    sequence: { include: { steps: true } },
                    person: {
                        select: {
                            emails: true,
                            country: true,
                            deletedAt: true,
                            company: { select: { address: true } },
                        },
                    },
                },
            }),
        );
    }

    /** The first stop condition that holds now, read from the database (FR-CRMS-5: before every step). */
    private async stopReason(e: EnrolmentRow): Promise<{ reason: EnrolmentStopReason; detail?: string } | null> {
        if (e.person.deletedAt) return { reason: 'person_deleted' };
        const address = primaryAddress(e);
        if (!address) return { reason: 'suppressed', detail: 'the person has no email address' };
        const found = await this.rls.withWorkspace(e.workspaceId, async (tx) => {
            const reply = await tx.mailMessage.findFirst({
                where: { fromAddress: { equals: address, mode: 'insensitive' }, sentAt: { gt: e.enrolledAt } },
                select: { id: true },
            });
            const excluded = (await this.exclusions.check(tx, [address])).get(address) ?? null;
            const policy = await this.regions.allowedIn(tx);
            const deal =
                e.dealId && e.sequence.pipelineId && e.sequence.stopOnPipelineExit
                    ? await tx.opportunity.findUnique({
                          where: { id: e.dealId },
                          select: { pipelineId: true, deletedAt: true, stage: { select: { kind: true } } },
                      })
                    : undefined;
            return { reply, excluded, deal, policy };
        });
        if (found.reply) return { reason: 'reply' };
        const suppressed = (await this.suppressions.check(e.workspaceId, [address])).get(address);
        if (suppressed) return { reason: SUPPRESSION_STOP[suppressed.reason] };
        if (found.excluded) return { reason: 'excluded', detail: found.excluded.reason };
        const blocked = blockedRegion(e.person, address, found.policy);
        if (blocked) return { reason: 'region_blocked', detail: blocked };
        if (
            found.deal !== undefined &&
            (!found.deal ||
                found.deal.deletedAt ||
                found.deal.pipelineId !== e.sequence.pipelineId ||
                found.deal.stage.kind !== 'open')
        ) {
            return { reason: 'pipeline_exit' };
        }
        return null;
    }

    private async finish(e: EnrolmentRow): Promise<RunOutcome> {
        await this.rls.withWorkspace(e.workspaceId, async (tx) => {
            const moved = await tx.sequenceEnrolment.updateMany({
                where: { id: e.id, status: 'active', nextRunAt: e.nextRunAt },
                data: { status: 'finished', finishedAt: new Date(), nextRunAt: null },
            });
            if (moved.count === 1) await this.announce(tx, e, 'enrolment.finished', { stepIndex: e.stepIndex });
        });
        return 'finished';
    }

    private async reschedule(
        workspaceId: string,
        e: EnrolmentRow,
        earliest: Date,
        window: SendWindow,
        zone: string,
    ): Promise<RunOutcome> {
        const at = nextWindowStart(earliest, zone, window);
        const moved = await this.rls.withWorkspace(workspaceId, async (tx) => {
            const ok = await claim(tx, e, { nextRunAt: at });
            if (ok) this.enqueueAfterCommit(workspaceId, e.id, at);
            return ok;
        });
        return moved ? 'rescheduled' : 'skipped';
    }

    private async hold(workspaceId: string, enrolmentId: string, reason: string, outboundId?: string): Promise<void> {
        await this.rls.withWorkspace(workspaceId, async (tx) => {
            const row = await tx.sequenceEnrolment.findUnique({ where: { id: enrolmentId } });
            if (!row || row.status !== 'active') return;
            if (outboundId && row.waitingOutboundId !== outboundId) return;
            const moved = await tx.sequenceEnrolment.updateMany({
                where: { id: enrolmentId, status: 'active', updatedAt: row.updatedAt },
                data: { status: 'held', heldReason: reason, nextRunAt: null, waitingOutboundId: null },
            });
            if (moved.count === 1) {
                await this.announceRow(tx, row, 'enrolment.held', { stepIndex: row.stepIndex, detail: reason });
            }
        });
    }

    /** The enrolment's most recent step send that went: its mailbox and the stored message it became. */
    private previousSend(workspaceId: string, enrolmentId: string) {
        return this.rls.withWorkspace(workspaceId, (tx) =>
            tx.mailOutbound.findFirst({
                where: { sequenceEnrolmentId: enrolmentId, status: 'sent' },
                orderBy: { sentAt: 'desc' },
                select: { mailboxId: true, mailMessageId: true },
            }),
        );
    }

    /** The template's variables this person has no value for, rendered as the step will be. */
    private async missingVariables(
        workspaceId: string,
        mailboxId: string,
        templateId: string,
        e: EnrolmentRow,
    ): Promise<readonly string[]> {
        const mailbox = await this.rls.withWorkspace(workspaceId, (tx) =>
            tx.mailbox.findUniqueOrThrow({ where: { id: mailboxId }, select: { ownerMemberId: true } }),
        );
        return this.context.run({ workspaceId, memberId: mailbox.ownerMemberId, capabilities: new Set() }, async () => {
            const template = await this.templates.get(templateId);
            const rendered = await this.renderer.render(
                { kind: 'outreach', subject: template.subject, body: template.body },
                { personId: e.personId, dealId: e.dealId ?? undefined, senderMemberId: mailbox.ownerMemberId },
            );
            return rendered.sendable ? [] : rendered.missing;
        });
    }

    private announce(
        tx: WorkspaceClient,
        e: EnrolmentRow,
        type: 'enrolment.step_completed' | 'enrolment.finished',
        payload: Omit<EnrolmentEventPayload, 'sequenceId' | 'personId'>,
    ): Promise<void> {
        return this.announceRow(tx, e, type, payload);
    }

    private announceRow(
        tx: WorkspaceClient,
        row: { id: string; workspaceId: string; sequenceId: string; personId: string },
        type: 'enrolment.step_completed' | 'enrolment.finished' | 'enrolment.held' | 'enrolment.stopped',
        payload: Omit<EnrolmentEventPayload, 'sequenceId' | 'personId'>,
    ): Promise<void> {
        return this.events.record(tx, {
            type,
            object: 'enrolment',
            workspaceId: row.workspaceId,
            actor: { kind: 'system', id: null },
            occurredAt: new Date().toISOString(),
            recordId: row.id,
            related: [{ type: 'person', id: row.personId }],
            enrolment: { sequenceId: row.sequenceId, personId: row.personId, ...payload },
        } as DomainEvent);
    }
}

function primaryAddress(e: { person: { emails: unknown } }): string | null {
    return (e.person.emails as Emails | null)?.primary?.trim().toLowerCase() || null;
}

/** Moves the enrolment only if it is still where the run read it; false when another hand moved it first. */
async function claim(
    tx: WorkspaceClient,
    e: EnrolmentRow,
    data: { stepIndex?: number; nextRunAt: Date | null },
): Promise<boolean> {
    const moved = await tx.sequenceEnrolment.updateMany({
        where: { id: e.id, status: 'active', stepIndex: e.stepIndex, nextRunAt: e.nextRunAt },
        data,
    });
    return moved.count === 1;
}

/** The blocked region a person now falls in under the workspace's policy, labelled; `null` when allowed. */
function blockedRegion(
    person: { country: string | null; company: { address: unknown } | null },
    address: string,
    policy: Record<RegionCode, boolean>,
): string | null {
    const companyCountry = (person.company?.address as { country?: string | null } | null)?.country ?? null;
    const region = regionOfCountry(
        inferCountry({ personCountry: person.country, companyCountry, email: address }).country,
    );
    return policy[region] ? null : `Region blocked: ${REGION_LABELS[region]} (policy)`;
}

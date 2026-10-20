import { Injectable, Logger } from '@nestjs/common';
import {
    REPUTATION_HOUR_MS,
    REPUTATION_WINDOW_MS,
    type ErrorCode,
    type GuardrailKind,
    type GuardrailPath,
    type GuardrailSeverity,
    type MailboxPause,
} from '@bylinecrm/shared';
import { DomainEvents } from '../events/domain-events.service';
import { ApiException } from '../infra/errors/api-errors';
import { RlsPrismaService } from '../infra/rls-prisma.service';
import { WorkspaceContext, type WorkspaceRunContext } from '../infra/workspace-context';
import { sendingDomainOf } from '../sending-pool/pool-mailbox';
import { EmailVerificationService } from '../verification/email-verification.service';
import { raiseAlert, utcDay } from './alerts';
import type { Fingerprint } from './fingerprint';
import { nearDuplicateRecipients, recipientsSince, subjectRecipients } from './judge';
import { primaryDomainIn, reputationSettingsIn } from './settings';
import { newThreadMail } from './window';

/** A send the reputation gate refused (REP-1): `422` with the code, nothing sent. */
export class ReputationRefusal extends ApiException {
    constructor(code: ErrorCode, message: string, details: Record<string, string>) {
        super(422, code, message, undefined, details);
    }
}

/** One recipient of a send being judged. */
export interface JudgedRecipient {
    address: string;
    personId: string | null;
}

export interface PersonalSendCheck {
    mailboxId: string;
    sendId: string;
    recipients: readonly JudgedRecipient[];
    fingerprint: Fingerprint;
    path: Extract<GuardrailPath, 'send' | 'scheduled_send'>;
    now?: Date;
}

interface Verdict {
    kind: GuardrailKind;
    /** Null: a warning — the send goes. */
    code: ErrorCode | null;
    severity: GuardrailSeverity;
    message: string;
    detail: Record<string, string>;
}

/**
 * The reputation gate (REP-1, #204, FR-CRMS-23): what a personal mailbox's new mail must pass before it
 * leaves — its new-recipient budget for the rolling 24 hours and hour, and the repetition rules (a near-identical
 * body to too many distinct people in 24 hours: "use a sequence from the pool"; the same subject to too many is a
 * warning, once a day, and the send goes). A reply
 * is never judged. Every refusal is a guardrail event (`blocked`); the first bulk pattern of a member's day tells
 * the reviewers. The counts include what the mailbox sent outside the CRM (Gmail sync), so a budget spent in
 * Gmail is spent here too. Judged at the send's request and, for a scheduled send, at its time.
 *
 * Soft limits: two sends judged at the same moment can both pass (no lock is held across a send); the next one
 * sees both.
 */
@Injectable()
export class ReputationGate {
    private readonly logger = new Logger(ReputationGate.name);

    constructor(
        private readonly rls: RlsPrismaService,
        private readonly context: WorkspaceContext,
        private readonly events: DomainEvents,
        private readonly verification: EmailVerificationService,
    ) {}

    async assertPersonalSend(check: PersonalSendCheck): Promise<void> {
        const context = this.current();
        const now = check.now ?? new Date();
        const mine = [...new Set(check.recipients.map((r) => r.address.trim().toLowerCase()))];
        const verdict = await this.rls.withWorkspace(context.workspaceId, async (tx): Promise<Verdict | null> => {
            // REP-2: a mailbox paused (reply-rate floor, domain spam rate) sends replies only.
            const mailbox = await tx.mailbox.findUnique({
                where: { id: check.mailboxId },
                select: { pausedAt: true, pauseReason: true },
            });
            const pause = mailbox?.pausedAt ? (mailbox.pauseReason as MailboxPause | null) : null;
            if (mailbox?.pausedAt) {
                const code = pause?.code ?? 'reply_rate';
                return {
                    kind: code === 'reply_rate' ? 'reply_rate' : 'spam_rate',
                    code: 'mailbox.paused',
                    severity: 'medium',
                    message: `This mailbox is paused for new recipients${pause?.message ? `: ${pause.message}` : ''}. Replies still go; a manager can resume it`,
                    detail: { pause: code },
                };
            }
            const s = await reputationSettingsIn(tx);
            const entries = await newThreadMail(
                tx,
                check.mailboxId,
                new Date(now.getTime() - REPUTATION_WINDOW_MS),
                check.sendId,
            );
            for (const [window, span, limit] of [
                ['day', REPUTATION_WINDOW_MS, s.dailyNewRecipients],
                ['hour', REPUTATION_HOUR_MS, s.hourlyNewRecipients],
            ] as const) {
                const used = recipientsSince(entries, new Date(now.getTime() - span));
                const adding = mine.filter((a) => !used.has(a)).length;
                if (used.size + adding > limit) {
                    const per = window === 'day' ? '24 hours' : 'hour';
                    return {
                        kind: 'send_budget',
                        code: 'mailbox.budget_reached',
                        severity: 'medium',
                        message: `This mailbox has written to ${used.size} new recipients in the last ${per}; its budget is ${limit}. Replies are not counted — try again later`,
                        detail: { window, used: String(used.size), limit: String(limit) },
                    };
                }
            }
            const others = (set: Set<string>) => [...set].filter((a) => !mine.includes(a)).length;
            const near = others(nearDuplicateRecipients(entries, check.fingerprint.simhash, s.nearDuplicateDistance));
            if (near >= s.nearDuplicateThreshold) {
                return {
                    kind: 'bulk_pattern',
                    code: 'message.bulk_pattern',
                    severity: 'high',
                    message: `This mailbox has sent a near-identical message to ${near} people in the last 24 hours (limit ${s.nearDuplicateThreshold}) — use a sequence from the sending pool`,
                    detail: { recipients: String(near), threshold: String(s.nearDuplicateThreshold) },
                };
            }
            // A repeated subject warns (the send goes): a cheap signal, not proof of bulk mail.
            const subject = others(subjectRecipients(entries, check.fingerprint.subjectKey));
            if (subject >= s.subjectRepeatThreshold) {
                return {
                    kind: 'subject_repeat',
                    code: null,
                    severity: 'medium',
                    message: `This subject has gone to ${subject + mine.length} new recipients from this mailbox in the last 24 hours (threshold ${s.subjectRepeatThreshold}) — bulk mail belongs in a sequence from the pool`,
                    detail: { recipients: String(subject + mine.length), threshold: String(s.subjectRepeatThreshold) },
                };
            }
            return null;
        });
        if (!verdict) return;
        const first = check.recipients[0];
        if (verdict.code === null) {
            // Warned once per mailbox per day, in the sender's bell and on the Guardrails page.
            await this.record(context, {
                kind: verdict.kind,
                severity: verdict.severity,
                path: check.path,
                outcome: 'warned',
                mailboxId: check.mailboxId,
                address: first?.address.toLowerCase() ?? null,
                personId: first?.personId ?? null,
                message: verdict.message,
                detail: verdict.detail,
                now,
                dedupeKey: `subject_repeat:send:${check.mailboxId}:${utcDay(now)}`,
                owner: context.memberId ?? null,
            });
            return;
        }
        await this.record(context, {
            kind: verdict.kind,
            severity: verdict.severity,
            path: check.path,
            outcome: 'blocked',
            mailboxId: check.mailboxId,
            address: first?.address.toLowerCase() ?? null,
            personId: first?.personId ?? null,
            message: verdict.message,
            detail: verdict.detail,
            now,
        });
        throw new ReputationRefusal(verdict.code, verdict.message, { reason: verdict.kind, ...verdict.detail });
    }

    /**
     * The recipient quality gate (REP-2, FR-CRMS-24) for a pool send, at its time: verification's answer for the
     * address — found again just in time when it is missing or stale. `invalid` (or still `unknown`) refuses the
     * send (`422 recipient.low_quality`, a `blocked` event); `risky` (a role address, a catch-all) lets it through
     * with a `warned` event, once per address per day.
     */
    async assertRecipientQuality(recipient: JudgedRecipient): Promise<void> {
        const context = this.current();
        const address = recipient.address.trim().toLowerCase();
        const verdict = (await this.verification.check(context.workspaceId, [address])).get(address);
        if (!verdict || verdict.result === 'valid') return;
        const now = new Date();
        const refuse = verdict.result === 'invalid' || verdict.result === 'unknown';
        const message =
            verdict.result === 'unknown'
                ? `${address} could not be verified — not sent from the pool`
                : `${address}: ${verdict.message}`;
        await this.record(context, {
            kind: 'recipient_quality',
            severity: refuse ? 'medium' : 'low',
            path: 'sequence_step',
            outcome: refuse ? 'blocked' : 'warned',
            mailboxId: null,
            address,
            personId: recipient.personId,
            message,
            detail: { result: verdict.result },
            now,
            ...(refuse ? {} : { dedupeKey: `recipient_quality:${address}:${utcDay(now)}` }),
        });
        if (refuse) throw new ReputationRefusal('recipient.low_quality', message, { result: verdict.result });
    }

    /**
     * The primary-domain rule (REP-1): with a primary domain known (set by an admin, or derived from the members'
     * sign-in addresses), a sequence enrolment needs a connected pool
     * mailbox on another (lookalike) domain to send from. Refuses — and records — otherwise.
     */
    async assertLookalikePool(path: Extract<GuardrailPath, 'sequence_enrol'>): Promise<void> {
        const context = this.current();
        const primary = await this.rls.withWorkspace(context.workspaceId, async (tx) => {
            const primaryDomain = await primaryDomainIn(tx, await reputationSettingsIn(tx));
            if (!primaryDomain) return null;
            const pool = await tx.mailbox.findMany({
                where: { purpose: 'pool', status: 'connected' },
                select: { email: true },
            });
            return pool.some((m) => sendingDomainOf(m.email) !== primaryDomain) ? null : primaryDomain;
        });
        if (!primary) return;
        const message = `Sequences send only from pool mailboxes on lookalike domains, and the pool has none off ${primary} — connect one first`;
        await this.record(context, {
            kind: 'primary_domain',
            severity: 'medium',
            path,
            outcome: 'blocked',
            mailboxId: null,
            address: null,
            personId: null,
            message,
            detail: { primaryDomain: primary },
            now: new Date(),
        });
        throw new ReputationRefusal('mailbox.primary_domain', message, { primaryDomain: primary });
    }

    /**
     * A pool send the pool's gate refused at its claim (worker, no request): a budget defers it (`deferred` —
     * the sequence tries the step again), the primary-domain rule blocks it.
     */
    async recordPoolRefusal(
        workspaceId: string,
        send: { senderMemberId: string; personId: string | null; toAddresses: readonly string[]; mailboxId: string },
        code: string,
        message: string,
    ): Promise<void> {
        const kind: GuardrailKind | null =
            code === 'mailbox.cap_reached'
                ? 'send_budget'
                : code === 'mailbox.primary_domain'
                  ? 'primary_domain'
                  : null;
        if (!kind) return;
        await this.record(
            { workspaceId, memberId: send.senderMemberId, capabilities: new Set() },
            {
                kind,
                severity: kind === 'primary_domain' ? 'medium' : 'low',
                path: 'pool_send',
                outcome: kind === 'send_budget' ? 'deferred' : 'blocked',
                mailboxId: send.mailboxId,
                address: send.toAddresses[0]?.toLowerCase() ?? null,
                personId: send.personId,
                message,
                detail: {},
                now: new Date(),
            },
        );
    }

    private async record(
        context: WorkspaceRunContext,
        e: {
            kind: GuardrailKind;
            severity: GuardrailSeverity;
            path: GuardrailPath;
            outcome: 'blocked' | 'deferred' | 'warned';
            mailboxId: string | null;
            dedupeKey?: string;
            /** Who is told in the bell besides reviewers (a warning's sender). */
            owner?: string | null;
            address: string | null;
            personId: string | null;
            message: string;
            detail: Record<string, string>;
            now: Date;
        },
    ): Promise<void> {
        const actor = context.memberId ?? null;
        try {
            await this.rls.withWorkspace(context.workspaceId, async (tx) => {
                // The first bulk pattern of a member's day tells the reviewers; later ones are on the page.
                const since = new Date(`${utcDay(e.now)}T00:00:00.000Z`);
                const firstToday =
                    e.kind === 'bulk_pattern' &&
                    (await tx.guardrailEvent.count({
                        where: { kind: 'bulk_pattern', actorMemberId: actor, createdAt: { gte: since } },
                    })) === 0;
                await raiseAlert(
                    tx,
                    this.events,
                    context,
                    {
                        kind: e.kind,
                        outcome: e.outcome,
                        severity: e.severity,
                        path: e.path,
                        actorMemberId: actor,
                        personId: e.personId,
                        address: e.address,
                        message: e.message,
                        detail: { ...e.detail, ...(e.mailboxId ? { mailboxId: e.mailboxId } : {}) },
                        ...(e.dedupeKey ? { dedupeKey: e.dedupeKey } : {}),
                    },
                    { owner: e.owner ?? null, reviewers: firstToday },
                );
            });
        } catch (error) {
            // The refusal stands whether or not its record was written; a lost row is logged.
            this.logger.error(
                `reputation event not written: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }

    private current(): WorkspaceRunContext {
        const context = this.context.get();
        if (!context) throw new Error('ReputationGate is used inside a workspace scope');
        return context;
    }
}

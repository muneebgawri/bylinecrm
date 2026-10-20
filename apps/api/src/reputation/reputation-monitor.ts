import { Injectable, Logger } from '@nestjs/common';
import { REPUTATION_WINDOW_MS, isNegativeReply } from '@bylinecrm/shared';
import { DomainEvents } from '../events/domain-events.service';
import { RlsPrismaService, type WorkspaceClient } from '../infra/rls-prisma.service';
import type { WorkspaceRunContext } from '../infra/workspace-context';
import { raiseAlert, utcDay } from './alerts';
import { normaliseBody } from './fingerprint';
import { largestNearDuplicate, largestSubject, recipientsSince } from './judge';
import { reputationSettingsIn } from './settings';
import { newThreadMail } from './window';

/**
 * The Gmail-side anomaly feed (REP-1 §10): after each sync of a mailbox, what left it in the last 24 hours —
 * however it was sent — is judged by the same rules the CRM enforces at send, and each finding is a
 * `warned` guardrail event (the mail already left; nothing can be blocked): `volume_anomaly` (over the
 * daily new-recipient budget), `bulk_pattern` (`high` — reviewers told too), `subject_repeat`. Replies that say
 * "unsubscribe" / "remove me" are `negative_reply`. The mailbox's owner is told in the bell. Each finding is
 * written at most once per mailbox per UTC day (a reply: once per message), so a sync every few minutes adds
 * nothing new. Pool mailboxes are judged for replies only: their volume is the pool's gate, and their mail is a
 * sequence's, which is meant to repeat.
 */
@Injectable()
export class ReputationMonitor {
    private readonly logger = new Logger(ReputationMonitor.name);

    constructor(
        private readonly rls: RlsPrismaService,
        private readonly events: DomainEvents,
    ) {}

    /** Never throws: a failed judgement is logged and the next sync tries again. */
    async afterSync(workspaceId: string, mailboxId: string, now = new Date()): Promise<void> {
        try {
            await this.judge(workspaceId, mailboxId, now);
        } catch (error) {
            this.logger.error(
                `reputation check of mailbox ${mailboxId} failed: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }

    async judge(workspaceId: string, mailboxId: string, now = new Date()): Promise<void> {
        await this.rls.withWorkspace(workspaceId, async (tx) => {
            const mailbox = await tx.mailbox.findUnique({
                where: { id: mailboxId },
                select: { id: true, email: true, purpose: true, ownerMemberId: true },
            });
            if (!mailbox) return;
            const context: WorkspaceRunContext = { workspaceId, capabilities: new Set() };
            const day = utcDay(now);
            const since = new Date(now.getTime() - REPUTATION_WINDOW_MS);
            const alert = (
                kind: 'volume_anomaly' | 'bulk_pattern' | 'subject_repeat',
                message: string,
                detail: Record<string, string>,
            ) =>
                raiseAlert(
                    tx,
                    this.events,
                    context,
                    {
                        kind,
                        outcome: 'warned',
                        severity: kind === 'bulk_pattern' ? 'high' : 'medium',
                        path: 'sync',
                        actorMemberId: mailbox.ownerMemberId,
                        message,
                        detail: { ...detail, mailboxId: mailbox.id, mailbox: mailbox.email },
                        dedupeKey: `${kind}:${mailbox.id}:${day}`,
                    },
                    { owner: mailbox.ownerMemberId, reviewers: kind === 'bulk_pattern' },
                );

            if (mailbox.purpose === 'personal') {
                const s = await reputationSettingsIn(tx);
                const entries = await newThreadMail(tx, mailbox.id, since);
                const volume = recipientsSince(entries, since).size;
                if (volume > s.dailyNewRecipients) {
                    await alert(
                        'volume_anomaly',
                        `${mailbox.email} wrote to ${volume} new recipients in 24 hours; the budget is ${s.dailyNewRecipients}`,
                        { recipients: String(volume), limit: String(s.dailyNewRecipients) },
                    );
                }
                const bulk = largestNearDuplicate(entries, s.nearDuplicateDistance);
                if (bulk.recipients >= s.nearDuplicateThreshold) {
                    await alert(
                        'bulk_pattern',
                        `${mailbox.email} sent a near-identical message to ${bulk.recipients} people in 24 hours (threshold ${s.nearDuplicateThreshold}) — bulk mail belongs in a sequence from the pool`,
                        { recipients: String(bulk.recipients), threshold: String(s.nearDuplicateThreshold) },
                    );
                }
                const subject = largestSubject(entries);
                if (subject.recipients >= s.subjectRepeatThreshold) {
                    await alert(
                        'subject_repeat',
                        `${mailbox.email} sent the subject “${subject.subjectKey}” to ${subject.recipients} new recipients in 24 hours (threshold ${s.subjectRepeatThreshold})`,
                        { recipients: String(subject.recipients), threshold: String(s.subjectRepeatThreshold) },
                    );
                }
            }
            await this.negativeReplies(tx, context, mailbox, since);
        });
    }

    /** Replies in the window, to this mailbox's mail, that say "stop": one event per reply. */
    private async negativeReplies(
        tx: WorkspaceClient,
        context: WorkspaceRunContext,
        mailbox: { id: string; email: string; ownerMemberId: string },
        since: Date,
    ): Promise<void> {
        const replies = await tx.$queryRaw<
            { id: string; from_address: string; body_text: string; person_id: string | null }[]
        >`
            SELECT m.id, lower(m.from_address) AS from_address, m.body_text,
                   (SELECT p.person_id FROM mail_participants p WHERE p.message_id = m.id AND p.role = 'from' LIMIT 1) AS person_id
            FROM mail_messages m
            JOIN mail_message_copies c ON c.message_id = m.id AND c.mailbox_id = ${mailbox.id}::uuid AND c.direction = 'inbound'
            WHERE m.sent_at >= ${since}
              AND m.in_reply_to IS NOT NULL
              AND EXISTS (
                  SELECT 1 FROM mail_message_copies oc
                  JOIN mail_messages o ON o.id = oc.message_id
                  WHERE oc.mailbox_id = ${mailbox.id}::uuid AND oc.direction = 'outbound' AND o.thread_id = m.thread_id
              )`;
        for (const r of replies) {
            // The reply's own words: quoted text and signature dropped, as the fingerprint drops them.
            if (!isNegativeReply(normaliseBody(r.body_text))) continue;
            await raiseAlert(
                tx,
                this.events,
                context,
                {
                    kind: 'negative_reply',
                    outcome: 'warned',
                    severity: 'low',
                    path: 'sync',
                    actorMemberId: mailbox.ownerMemberId,
                    personId: r.person_id,
                    address: r.from_address,
                    message: `${r.from_address} replied asking not to be mailed`,
                    detail: { mailboxId: mailbox.id, messageId: r.id },
                    dedupeKey: `negative_reply:${r.id}`,
                },
                { owner: mailbox.ownerMemberId, reviewers: false },
            );
        }
    }
}

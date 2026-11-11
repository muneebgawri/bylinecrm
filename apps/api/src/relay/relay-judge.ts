import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { OFF_CRM_COLD_WINDOW_MS, POACH_HIGH_WINDOW_MS } from '@bylinecrm/shared';
import { ENV, type Env } from '../config/env';
import { DomainEvents } from '../events/domain-events.service';
import { guardrailSettings, ownerlessMembers } from '../guardrails/guardrail-settings';
import { internalDomains, readRecipients } from '../guardrails/poach-detector';
import { leadKey, offCrmColdSeverity, poachSeverity } from '../guardrails/poach-rules';
import { recordGuardrailEvents, reviewersIn } from '../guardrails/record';
import { PrismaService } from '../infra/prisma.service';
import { RlsPrismaService, type WorkspaceClient } from '../infra/rls-prisma.service';
import type { WorkspaceRunContext } from '../infra/workspace-context';
import { notify } from '../notifications/notify';
import type { MessageHeaders } from './headers';
import { relayBlockedMessage, relayBounceText, relayRefusals, type RelayRefusal } from './relay-rules';

/** The header the relay stamps on what it lets through; the Workspace rule exempts it (no second trip). */
export const RELAY_STAMP_HEADER = 'X-BylineCRM-Relay';
/** The header a CRM send carries (`MailSendService`); the Workspace rule exempts it too, so one is never seen here. */
export const CRM_SEND_HEADER = 'X-BylineCRM-Id';

export type RelayVerdict =
    /** Let it leave: the stamp goes on the message. */
    | { kind: 'relay'; workspaceId: string; stamp: string }
    /** Bounce it with this text (SMTP 550). The events are written. */
    | { kind: 'refuse'; text: string }
    /** Not a mailbox of any workspace (or its member has left): not ours to carry. */
    | { kind: 'unknown_sender' };

export interface RelayInput {
    /** The envelope sender (MAIL FROM), lower-cased. */
    from: string;
    /** The envelope recipients (RCPT TO), lower-cased: to, cc and bcc alike — the only complete list. */
    recipients: readonly string[];
    headers: MessageHeaders;
    now?: Date;
}

/**
 * GUARD-4's judge: the decision a routed message gets, over the same facts GUARD-2 and GUARD-3 read. The
 * sender's mailbox names the workspace (the owner client sees across workspaces; everything after runs scoped
 * to that one). A pool or service mailbox's mail is a sequence's or a shared inbox's, never a rep's: relayed
 * unjudged, as those guards leave it. A CRM send is relayed unjudged too — the guard already judged it at send.
 * Every refusal is a `blocked` guardrail event on path `relay` (the lead's owner and the reviewers are told,
 * as GUARD-2 tells them), and the bounce says who and why; the relay never says more than the event does.
 */
@Injectable()
export class RelayJudge {
    private readonly logger = new Logger(RelayJudge.name);

    constructor(
        @Inject(ENV) private readonly env: Pick<Env, 'WEB_URL'>,
        private readonly owner: PrismaService,
        private readonly rls: RlsPrismaService,
        private readonly events: DomainEvents,
    ) {}

    async judge(input: RelayInput): Promise<RelayVerdict> {
        const now = input.now ?? new Date();
        const mailbox = await this.mailboxOf(input.from);
        if (!mailbox) return { kind: 'unknown_sender' };
        if (mailbox.purpose !== 'personal' || input.headers.has(CRM_SEND_HEADER)) {
            return { kind: 'relay', workspaceId: mailbox.workspaceId, stamp: randomUUID() };
        }
        return this.rls.withWorkspace(mailbox.workspaceId, async (tx) => {
            const sender = await tx.workspaceMember.findFirst({
                where: { id: mailbox.ownerMemberId, leftAt: null },
                select: { id: true, user: { select: { displayName: true, email: true } } },
            });
            if (!sender) return { kind: 'unknown_sender' as const };

            const settings = await guardrailSettings(tx);
            const members = await tx.workspaceMember.findMany({
                where: { leftAt: null },
                select: { id: true, user: { select: { email: true } } },
            });
            const memberByAddress = new Map(members.map((m) => [m.user.email.toLowerCase(), m.id]));
            const recipients = [...new Set(input.recipients.map((a) => a.toLowerCase()))].map((address) => ({
                address,
                personId: null,
                memberId: memberByAddress.get(address) ?? null,
            }));
            const facts = await readRecipients(tx, recipients, await ownerlessMembers(tx, settings));
            const thread = await this.threadOf(tx, input.headers.referencedMessageIds(), now);
            const refusals = relayRefusals({
                senderId: sender.id,
                recipients: facts,
                internalDomains: await internalDomains(tx),
                threadMembers: thread.members,
                threadSenders: thread.senders,
            });
            if (refusals.length === 0) {
                return { kind: 'relay' as const, workspaceId: mailbox.workspaceId, stamp: randomUUID() };
            }

            const owners = await this.ownerNames(tx, refusals);
            await this.record(tx, mailbox.workspaceId, {
                sender: { id: sender.id, name: sender.user.displayName ?? sender.user.email, address: input.from },
                refusals,
                owners,
                subject: input.headers.get('subject') ?? '',
                messageId: input.headers.get('message-id'),
                now,
            });
            this.logger.log(
                `bounced ${input.from}: ${refusals.map((r) => `${r.address} (${r.kind})`).join(', ')} [workspace ${mailbox.workspaceId}]`,
            );
            return { kind: 'refuse' as const, text: relayBounceText(refusals, owners, this.env.WEB_URL) };
        });
    }

    /** The personal, pool or service mailbox at the sender's address; the owner client, since no workspace is known yet. */
    private async mailboxOf(address: string) {
        const mailboxes = await this.owner.mailbox.findMany({
            where: { email: address },
            select: { workspaceId: true, purpose: true, ownerMemberId: true, status: true, connectedAt: true },
            orderBy: { connectedAt: 'desc' },
        });
        return mailboxes.find((m) => m.status !== 'disconnected') ?? mailboxes[0] ?? null;
    }

    /**
     * The thread the message answers, as sync stored it: the members on it and the addresses that wrote before
     * `now`. The same facts GUARD-2 reads for a stored message, from the `In-Reply-To` / `References` ids.
     */
    private async threadOf(
        tx: WorkspaceClient,
        ids: readonly string[],
        now: Date,
    ): Promise<{ members: Set<string>; senders: Set<string> }> {
        const members = new Set<string>();
        const senders = new Set<string>();
        if (ids.length === 0) return { members, senders };
        const known = await tx.mailMessage.findMany({
            where: { rfc822MessageId: { in: [...ids] } },
            select: { threadId: true },
        });
        const threadIds = [...new Set(known.map((m) => m.threadId))];
        if (threadIds.length === 0) return { members, senders };
        const participants = await tx.mailParticipant.findMany({
            where: { message: { threadId: { in: threadIds } } },
            select: { role: true, address: true, memberId: true, message: { select: { sentAt: true } } },
        });
        for (const p of participants) {
            if (p.memberId) members.add(p.memberId);
            if (p.role === 'from' && p.message.sentAt < now) senders.add(p.address.toLowerCase());
        }
        return { members, senders };
    }

    private async ownerNames(tx: WorkspaceClient, refusals: readonly RelayRefusal[]): Promise<Map<string, string>> {
        const ids = [...new Set(refusals.flatMap((r) => (r.ownerId ? [r.ownerId] : [])))];
        if (ids.length === 0) return new Map();
        const owners = await tx.workspaceMember.findMany({
            where: { id: { in: ids }, leftAt: null },
            select: { id: true, user: { select: { displayName: true, email: true } } },
        });
        return new Map(owners.map((o) => [o.id, o.user.displayName ?? o.user.email]));
    }

    /** One `blocked` event per refused address, with GUARD-2's and GUARD-3's severity ladders and notifications. */
    private async record(
        tx: WorkspaceClient,
        workspaceId: string,
        input: {
            sender: { id: string; name: string; address: string };
            refusals: readonly RelayRefusal[];
            owners: ReadonlyMap<string, string>;
            subject: string;
            messageId: string | null;
            now: Date;
        },
    ): Promise<void> {
        const { sender, refusals, now } = input;
        const context: WorkspaceRunContext = { workspaceId, capabilities: new Set() };
        const reviewers = await reviewersIn(tx, sender.id);
        const earlierPoach = await tx.guardrailEvent.findMany({
            where: {
                kind: 'poach_suspected',
                actorMemberId: sender.id,
                createdAt: { gte: new Date(now.getTime() - POACH_HIGH_WINDOW_MS) },
            },
            select: { personId: true, address: true },
        });
        const earlierCold = await tx.guardrailEvent.findMany({
            where: {
                kind: 'off_crm_cold',
                actorMemberId: sender.id,
                createdAt: { gte: new Date(now.getTime() - OFF_CRM_COLD_WINDOW_MS) },
            },
            select: { address: true },
        });
        const poachLeads = new Set(earlierPoach.map(leadKey));
        const coldAddresses = new Set(earlierCold.flatMap((e) => (e.address ? [e.address] : [])));
        const batch = input.messageId ?? randomUUID();

        for (const refusal of refusals) {
            const ownerName = refusal.ownerId ? (input.owners.get(refusal.ownerId) ?? null) : null;
            let severity;
            if (refusal.kind === 'poach_suspected') {
                poachLeads.add(leadKey(refusal));
                severity = poachSeverity(poachLeads.size);
            } else {
                coldAddresses.add(refusal.address);
                severity = offCrmColdSeverity(coldAddresses.size);
            }
            const told = new Set<string>(reviewers);
            if (refusal.ownerId && ownerName) told.add(refusal.ownerId);
            const [event] = await recordGuardrailEvents(
                tx,
                this.events,
                context,
                [
                    {
                        kind: refusal.kind,
                        outcome: 'blocked',
                        severity,
                        path: 'relay',
                        actorMemberId: sender.id,
                        ownerMemberId: refusal.ownerId,
                        personId: refusal.personId,
                        companyId: refusal.companyId,
                        address: refusal.address,
                        message: relayBlockedMessage({
                            senderName: sender.name,
                            senderAddress: sender.address,
                            refusal,
                            ownerName,
                            subject: input.subject,
                            at: now,
                        }),
                        detail: {
                            subject: input.subject.slice(0, 200),
                            attemptedAt: now.toISOString(),
                            ...(input.messageId ? { messageId: input.messageId } : {}),
                            ...(refusal.exclusion
                                ? {
                                      exclusionSource: refusal.exclusion.source,
                                      exclusionReason: refusal.exclusion.reason,
                                  }
                                : {}),
                        },
                        notifiedMemberIds: [...told],
                        dedupeKey: `relay:${batch}:${refusal.address}`,
                    },
                ],
                true,
            );
            if (!event) continue;
            // GUARD-3 tells reviewers from `medium`; a `low` cold bounce is the audit row (the rep saw the bounce).
            if (refusal.kind === 'off_crm_cold' && severity === 'low') continue;
            const kind = refusal.kind === 'poach_suspected' ? 'guardrail_poach_suspected' : 'guardrail_off_crm_cold';
            await notify(tx, workspaceId, told, kind, [{ type: 'guardrail', id: event.id }]);
        }
    }
}

import { Injectable } from '@nestjs/common';
import { POACH_DEDUPE_WINDOW_MS, POACH_HIGH_WINDOW_MS, POACH_LOOKBACK_MS, type DomainEvent } from '@bylinecrm/shared';
import { isFreeMailDomain } from '../enrichment/email-domain';
import { DomainEvents } from '../events/domain-events.service';
import { OutboxConsumerOf, type DeliveredEvent, type OutboxConsumer } from '../events/outbox-consumer';
import { RlsPrismaService, type WorkspaceClient } from '../infra/rls-prisma.service';
import type { WorkspaceRunContext } from '../infra/workspace-context';
import { notify } from '../notifications/notify';
import { companyDomainOfAddress, normalisedDomain } from '../records/company-ownership';
import { exclusionHits } from '../sequences/exclusions.service';
import { AccountMail } from '../transactional-mail/account-mail';
import {
    domainOf,
    leadKey,
    poachFindings,
    poachMessage,
    poachSeverity,
    type PoachFinding,
    type PoachRecipient,
} from './poach-rules';
import { recordGuardrailEvents, reviewersIn } from './record';

/**
 * The poaching detector (GUARD-2, #203, FR-CRMS-22). Every message that left a member's mailbox — synced from
 * Gmail or sent from the CRM; both are stored by mail sync's one writer, which announces `email.sent` /
 * `email.received` — is judged once: each recipient owned by another member (not as a reply in a thread that
 * member is on), or on the outreach exclusions, is a `poach_suspected` guardrail event (`warned`: the mail has
 * left). The lead's owner and every reviewer (managers, admins) are told in the bell and the daily digest, and at
 * `high` by email at once. Notifications say who, whom, when and the subject — never the body.
 *
 * Noise kept down: mail older than `POACH_LOOKBACK_MS` when seen (a first sync's history) is not judged; members
 * and the workspace's own domains are internal; free-mail domains never match a company; pool (sequence) mail is
 * the enrolment guard's; and one alert per sender, owner and lead within `POACH_DEDUPE_WINDOW_MS`.
 */
@Injectable()
export class PoachDetector {
    constructor(
        private readonly rls: RlsPrismaService,
        private readonly events: DomainEvents,
        private readonly mail: AccountMail,
    ) {}

    /** Judges one stored message; returns the events written. Idempotent (each event's key is message + address). */
    async judge(workspaceId: string, messageId: string, now = new Date()): Promise<number> {
        return this.rls.withWorkspace(workspaceId, async (tx) => {
            const message = await tx.mailMessage.findUnique({
                where: { id: messageId },
                select: {
                    id: true,
                    threadId: true,
                    subject: true,
                    sentAt: true,
                    fromAddress: true,
                    participants: { select: { role: true, address: true, personId: true, memberId: true } },
                    _count: { select: { outboundOf: true } },
                },
            });
            if (!message) return 0;
            if (now.getTime() - message.sentAt.getTime() > POACH_LOOKBACK_MS) return 0;
            const fromAddress = message.fromAddress.toLowerCase();
            const sender = await senderOf(tx, message.participants, fromAddress);
            if (!sender) return 0;

            const recipients = message.participants.filter((p) => p.role !== 'from');
            const facts = await readRecipients(tx, recipients);
            const thread = await tx.mailParticipant.findMany({
                where: { message: { threadId: message.threadId } },
                select: { role: true, address: true, memberId: true, message: { select: { sentAt: true } } },
            });
            const findings = poachFindings({
                senderId: sender.memberId,
                recipients: facts,
                internalDomains: await internalDomains(tx),
                threadMembers: new Set(thread.flatMap((p) => (p.memberId ? [p.memberId] : []))),
                threadSenders: new Set(
                    thread
                        .filter((p) => p.role === 'from' && p.message.sentAt < message.sentAt)
                        .map((p) => p.address.toLowerCase()),
                ),
            });
            if (findings.length === 0) return 0;

            const context: WorkspaceRunContext = { workspaceId, capabilities: new Set() };
            let written = 0;
            for (const finding of findings) {
                if (await this.recentlyAlerted(tx, sender.memberId, finding, now)) continue;
                const ok = await this.raise(tx, context, {
                    finding,
                    sender,
                    fromAddress,
                    message,
                    path: message._count.outboundOf > 0 ? 'send' : 'sync',
                    now,
                });
                if (ok) written += 1;
            }
            return written;
        });
    }

    /** One alert per (sender, owner, lead) within the dedupe window. */
    private async recentlyAlerted(
        tx: WorkspaceClient,
        senderId: string,
        finding: PoachFinding,
        now: Date,
    ): Promise<boolean> {
        const hit = await tx.guardrailEvent.findFirst({
            where: {
                kind: 'poach_suspected',
                actorMemberId: senderId,
                ownerMemberId: finding.ownerId,
                ...(finding.personId ? { personId: finding.personId } : { address: finding.address }),
                createdAt: { gte: new Date(now.getTime() - POACH_DEDUPE_WINDOW_MS) },
            },
            select: { id: true },
        });
        return hit !== null;
    }

    private async raise(
        tx: WorkspaceClient,
        context: WorkspaceRunContext,
        input: {
            finding: PoachFinding;
            sender: { memberId: string; name: string };
            fromAddress: string;
            message: { id: string; threadId: string; subject: string; sentAt: Date };
            path: 'send' | 'sync';
            now: Date;
        },
    ): Promise<boolean> {
        const { finding, sender, message } = input;
        const earlier = await tx.guardrailEvent.findMany({
            where: {
                kind: 'poach_suspected',
                actorMemberId: sender.memberId,
                createdAt: { gte: new Date(input.now.getTime() - POACH_HIGH_WINDOW_MS) },
            },
            select: { personId: true, address: true },
        });
        const leads = new Set([...earlier.map(leadKey), leadKey(finding)]);
        const severity = poachSeverity(leads.size);
        const owner = finding.ownerId
            ? await tx.workspaceMember.findFirst({
                  where: { id: finding.ownerId, leftAt: null },
                  select: { id: true, user: { select: { displayName: true, email: true } } },
              })
            : null;
        const told = new Set<string>(await reviewersIn(tx, sender.memberId));
        if (owner) told.add(owner.id);
        const text = poachMessage({
            senderName: sender.name,
            senderAddress: input.fromAddress,
            address: finding.address,
            ownerName: owner ? (owner.user.displayName ?? owner.user.email) : null,
            exclusionSource: finding.exclusion?.source ?? null,
            sentAt: message.sentAt,
            subject: message.subject,
        });
        const [event] = await recordGuardrailEvents(
            tx,
            this.events,
            context,
            [
                {
                    kind: 'poach_suspected',
                    outcome: 'warned',
                    severity,
                    path: input.path,
                    actorMemberId: sender.memberId,
                    ownerMemberId: finding.ownerId,
                    personId: finding.personId,
                    companyId: finding.companyId,
                    address: finding.address,
                    message: text,
                    detail: {
                        messageId: message.id,
                        threadId: message.threadId,
                        subject: message.subject.slice(0, 200),
                        sentAt: message.sentAt.toISOString(),
                        leads: String(leads.size),
                        ...(finding.exclusion
                            ? { exclusionSource: finding.exclusion.source, exclusionReason: finding.exclusion.reason }
                            : {}),
                    },
                    notifiedMemberIds: [...told],
                    dedupeKey: `poach_suspected:${message.id}:${finding.address}`,
                },
            ],
            true,
        );
        if (!event) return false;
        await notify(tx, context.workspaceId, told, 'guardrail_poach_suspected', [{ type: 'guardrail', id: event.id }]);
        if (severity === 'high') await this.emailAtOnce(tx, context.workspaceId, event.id, told, text);
        return true;
    }

    /** At `high`: each told member gets an email now (through the outbox; it leaves after commit). */
    private async emailAtOnce(
        tx: WorkspaceClient,
        workspaceId: string,
        eventId: string,
        memberIds: ReadonlySet<string>,
        message: string,
    ): Promise<void> {
        const members = await tx.workspaceMember.findMany({
            where: { id: { in: [...memberIds] }, leftAt: null },
            select: { id: true, user: { select: { email: true } }, workspace: { select: { name: true } } },
        });
        for (const m of members) {
            await this.mail.guardrailAlert(tx, {
                workspaceId,
                to: m.user.email,
                memberId: m.id,
                eventId,
                workspaceName: m.workspace.name,
                message,
                path: `/w/${workspaceId}/settings/guardrails`,
            });
        }
    }
}

/**
 * GUARD-2's subscriber: `email.sent` and `email.received` (a member's mail can first be seen in a colleague's
 * mailbox). The detector judges the stored message; redelivery writes nothing twice.
 */
@Injectable()
@OutboxConsumerOf('poach-detector')
export class PoachDetectorConsumer implements OutboxConsumer {
    constructor(private readonly detector: PoachDetector) {}

    accepts(event: DomainEvent): boolean {
        return event.type === 'email.sent' || event.type === 'email.received';
    }

    async consume({ event }: DeliveredEvent): Promise<void> {
        await this.detector.judge(event.workspaceId, event.recordId);
    }
}

/**
 * The member who sent it: the `from` participant's member, else the owner of the personal mailbox with that
 * address. Mail from a pool mailbox is a sequence's (the enrolment guard's), so it has no sender here.
 */
async function senderOf(
    tx: WorkspaceClient,
    participants: readonly { role: string; address: string; memberId: string | null }[],
    fromAddress: string,
): Promise<{ memberId: string; name: string } | null> {
    const mailbox = await tx.mailbox.findFirst({
        where: { email: fromAddress },
        select: { purpose: true, ownerMemberId: true },
    });
    if (mailbox?.purpose === 'pool') return null;
    const memberId = participants.find((p) => p.role === 'from')?.memberId ?? mailbox?.ownerMemberId ?? null;
    if (!memberId) return null;
    const member = await tx.workspaceMember.findUnique({
        where: { id: memberId },
        select: { id: true, user: { select: { displayName: true, email: true } } },
    });
    return member ? { memberId: member.id, name: member.user.displayName ?? member.user.email } : null;
}

/** What the workspace knows of each recipient: the person, their company, the owner, an exclusion. */
async function readRecipients(
    tx: WorkspaceClient,
    recipients: readonly { address: string; personId: string | null; memberId: string | null }[],
): Promise<PoachRecipient[]> {
    const addresses = [...new Set(recipients.map((r) => r.address.toLowerCase()))];
    if (addresses.length === 0) return [];
    const ids = [...new Set(recipients.flatMap((r) => (r.personId ? [r.personId] : [])))];
    const people = await tx.person.findMany({
        where: { deletedAt: null, OR: [{ id: { in: ids } }, { emailPrimary: { in: addresses } }] },
        select: { id: true, ownerId: true, companyId: true, emailPrimary: true },
        orderBy: { createdAt: 'asc' },
    });
    const byId = new Map(people.map((p) => [p.id, p]));
    const byAddress = new Map<string, (typeof people)[number]>();
    for (const p of people) if (p.emailPrimary && !byAddress.has(p.emailPrimary)) byAddress.set(p.emailPrimary, p);

    // Companies: those people are linked to, and those at each address's company domain (never free mail).
    const domains = [...new Set(addresses.flatMap((a) => companyDomainOfAddress(a) ?? []))];
    const forms = domains.flatMap((d) => [normalisedDomain(d), `www.${normalisedDomain(d)}`]);
    const linkedIds = [...new Set(people.flatMap((p) => (p.companyId ? [p.companyId] : [])))];
    const companies = await tx.company.findMany({
        where: {
            deletedAt: null,
            OR: [
                { id: { in: linkedIds } },
                { domain: { in: forms } },
                { otherDomains: { some: { domain: { in: forms } } } },
            ],
        },
        select: { id: true, ownerId: true, domain: true, otherDomains: { select: { domain: true } } },
        orderBy: { createdAt: 'asc' },
    });
    const companyById = new Map(companies.map((c) => [c.id, c]));
    const companyByDomain = new Map<string, (typeof companies)[number]>();
    for (const c of companies) {
        for (const d of [c.domain, ...c.otherDomains.map((x) => x.domain)]) {
            if (!d) continue;
            const key = normalisedDomain(d);
            if (!companyByDomain.has(key)) companyByDomain.set(key, c);
        }
    }
    const excluded = await exclusionHits(tx, addresses);

    return recipients.map((r) => {
        const address = r.address.toLowerCase();
        const person = (r.personId ? byId.get(r.personId) : undefined) ?? byAddress.get(address) ?? null;
        const domain = companyDomainOfAddress(address);
        const company =
            (person?.companyId ? companyById.get(person.companyId) : undefined) ??
            (domain ? companyByDomain.get(normalisedDomain(domain)) : undefined) ??
            null;
        const hit = excluded.get(address);
        return {
            address,
            memberId: r.memberId,
            personId: person?.id ?? null,
            companyId: company?.id ?? null,
            ownerId: person?.ownerId ?? company?.ownerId ?? null,
            exclusion: hit ? { source: hit.source, reason: hit.reason } : null,
        };
    });
}

/**
 * The workspace's own domains: its members' and mailboxes' addresses, its sending domains and its primary domain —
 * free mail never (a member signed up with Gmail does not make every Gmail address internal).
 */
export async function internalDomains(tx: WorkspaceClient): Promise<Set<string>> {
    const [members, mailboxes, sending, settings] = await Promise.all([
        tx.workspaceMember.findMany({ select: { user: { select: { email: true } } } }),
        tx.mailbox.findMany({ select: { email: true } }),
        tx.sendingDomain.findMany({ select: { domain: true } }),
        tx.reputationSettings.findFirst({ select: { primaryDomain: true } }),
    ]);
    const domains = new Set<string>();
    const add = (d: string | null | undefined) => {
        if (!d) return;
        const domain = d.toLowerCase();
        if (!isFreeMailDomain(domain)) domains.add(domain);
    };
    for (const m of members) add(domainOf(m.user.email));
    for (const m of mailboxes) add(domainOf(m.email));
    for (const s of sending) add(s.domain);
    add(settings?.primaryDomain);
    return domains;
}

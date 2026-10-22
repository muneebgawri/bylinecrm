import { Injectable, Logger } from '@nestjs/common';
import {
    GUARDRAIL_REPEAT_BLOCKS_PER_DAY,
    OWNED_GUARDRAIL_KINDS,
    SUPPRESSION_REASON_LABELS,
    type GuardrailKind,
    type GuardrailOutcome,
    type GuardrailPath,
    type GuardrailSeverity,
} from '@bylinecrm/shared';
import { Prisma, type SuppressionReason } from '@prisma/client';
import { DomainEvents } from '../events/domain-events.service';
import { ApiException } from '../infra/errors/api-errors';
import { RlsPrismaService, type WorkspaceClient } from '../infra/rls-prisma.service';
import { WorkspaceContext, type WorkspaceRunContext } from '../infra/workspace-context';
import { CompanyOwnership, companyDomainOfAddress, type DomainCompany } from '../records/company-ownership';
import { exclusionHits, exclusionMessage } from '../sequences/exclusions.service';
import { SuppressionService } from '../suppression/suppression.service';
import { effectiveOwner, guardrailSettings } from './guardrail-settings';
import { recordGuardrailEvents, reviewersIn } from './record';

/** One address an outbound path is about to reach, and the person it is, when the caller knows. */
export interface GuardRecipient {
    address: string;
    personId: string | null;
    /** The header field (`to`, `cc`, `bcc`) or request path it came from, for the refusal's field errors. */
    field?: string;
}

/** The paths the guard is asked from (`repeat_blocks` is its own tally, never a caller's). */
export type GuardPath = Exclude<GuardrailPath, 'repeat_blocks'>;

export interface GuardRequest {
    path: GuardPath;
    recipients: readonly GuardRecipient[];
    /** A sequence's mail (enrolment or step): exclusions bind everyone, the record's owner included. */
    outreach: boolean;
    /** The message a reply answers: a colleague's lead in a thread they are on may be answered. */
    replyToMessageId?: string | null | undefined;
    /** Write the audit (default). A preview asks without leaving a trace. */
    record?: boolean;
}

/** What the guard decided for one recipient. `pass` leaves no record. */
export interface GuardVerdict {
    address: string;
    personId: string | null;
    field?: string | undefined;
    outcome: GuardrailOutcome | 'pass';
    kind?: GuardrailKind;
    message: string;
    /** For a suppressed recipient: why (the existing `recipient.suppressed` refusal says so). */
    suppression?: SuppressionReason;
    /** Whose lead it is (`owned_by_other`, `in_negotiation`, `cold_to_known`). */
    owner?: { memberId: string; name: string | null } | undefined;
    companyId?: string | null | undefined;
    detail?: Record<string, string>;
}

const SEVERITY: Readonly<Record<GuardrailKind, GuardrailSeverity>> = {
    suppressed: 'low',
    excluded_customer: 'medium',
    excluded_account_managed: 'medium',
    owned_by_other: 'medium',
    in_negotiation: 'medium',
    cold_to_known: 'low',
    repeat_blocks: 'high',
    record_export: 'low',
    // REP-1's kinds are written by the reputation gate and monitor with their own severity; listed for completeness.
    send_budget: 'medium',
    volume_anomaly: 'medium',
    bulk_pattern: 'high',
    subject_repeat: 'medium',
    negative_reply: 'low',
    primary_domain: 'medium',
    recipient_quality: 'medium',
    reply_rate: 'high',
    spam_rate: 'high',
    poach_suspected: 'medium',
};

const NAMED = { select: { user: { select: { displayName: true } } } } as const;

/**
 * `422 recipient.guarded` (GUARD-1, FR-CRMS-21): a recipient the guard refused for a reason other than the
 * suppression list (which keeps its own `recipient.suppressed`). Each one is named at its field; `details`
 * says why for the first and, for another member's lead, whose — so the composer can offer "Ask <owner> to
 * introduce you". Nothing was sent.
 */
export class RecipientGuarded extends ApiException {
    constructor(blocked: readonly GuardVerdict[]) {
        const first = blocked[0]!;
        super(
            422,
            'recipient.guarded',
            `${first.address}: ${first.message}. Nothing was sent.`,
            blocked.map((v) => ({ path: v.field ?? 'to', message: `${v.address}: ${v.message}` })),
            {
                reason: first.kind ?? 'owned_by_other',
                ...(first.owner ? { ownerMemberId: first.owner.memberId, ownerName: first.owner.name ?? '' } : {}),
            },
        );
    }
}

/**
 * The recipient guard (GUARD-1, #202, FR-CRMS-21): one check every outbound path asks before mail leaves —
 * a send now, a reply, a scheduled send at its time (a retry is one), a sequence enrolment (one person or
 * many) and every sequence step's send. The sender is the caller in the current workspace scope: the member
 * sending, or (for a scheduled send and a sequence step) the member who scheduled or enrolled, as their role
 * stands now. Reasons, in order — the first that holds is the verdict:
 *
 * 1. **`suppressed`** — the suppression list (P3-1). Everyone.
 * 2. **`excluded_customer` / `excluded_account_managed`** — the outreach exclusions (FR-CRMS-10), now for
 *    one-to-one mail too. Everyone, admins included; for one-to-one mail the record's owner (the person's, or
 *    the company's at the address's domain) may still write to their own customer, and anyone may answer a
 *    thread the customer wrote in. A sequence never reaches one.
 * 3. **`in_negotiation`** — the address's company has an open deal another member owns: the stronger form of 4,
 *    told instead of it.
 * 4. **`owned_by_other`** — the person, or the company at the address's domain (OWN-2), is another member's.
 *    A reply in a thread that member is on is not poaching (a colleague cc'd them in).
 * 5. **`cold_to_known`** — enrolling in a sequence someone already in a two-way thread with the workspace:
 *    a warning for the person's owner (or a manager), a block for anyone else.
 *
 * A lead a shared mailbox owns (Settings → Guardrails: outreach@, which many people send from) is nobody's here:
 * 3–5 read its owner as none, so any member may mail it. Its ownership is not changed.
 *
 * A holder of `record:transfer` (managers, admins) is not refused 3–5 — the attempt is kept as `allowed`.
 * A job or API key with no member is not judged on 3–5 (there is nobody whose lead it would take).
 *
 * Ownership is read across the workspace, outside an own-scoped caller's record scope: an account manager who
 * cannot see a colleague's lead must still be told it is theirs. Every verdict other than `pass` is written to
 * `guardrail_events` (unless the caller only previews), and a member's third block on owned addresses in a UTC
 * day tells every reviewer (`guardrail:review`, admins) once.
 */
@Injectable()
export class RecipientGuard {
    private readonly logger = new Logger(RecipientGuard.name);

    constructor(
        private readonly rls: RlsPrismaService,
        private readonly context: WorkspaceContext,
        private readonly suppressions: SuppressionService,
        private readonly ownership: CompanyOwnership,
        private readonly events: DomainEvents,
    ) {}

    async check(request: GuardRequest): Promise<GuardVerdict[]> {
        const context = this.context.get();
        if (!context) throw new Error('RecipientGuard is used inside a workspace scope');
        const sender = context.memberId ?? null;
        const exempt = context.capabilities.has('record:transfer');
        const recipients = request.recipients.map((r) => ({ ...r, address: r.address.trim().toLowerCase() }));
        const addresses = [...new Set(recipients.map((r) => r.address))];
        if (addresses.length === 0) return [];

        const suppressed = await this.suppressions.check(context.workspaceId, addresses);
        // Who owns each domain, read the one way OWN-2 reads it.
        const domains = new Map<string, DomainCompany | null>();
        for (const address of addresses) {
            const domain = companyDomainOfAddress(address);
            if (domain && !domains.has(domain))
                domains.set(domain, await this.ownership.companyForDomain(context, domain));
        }
        const facts = await this.widened(context, (tx) => readFacts(tx, request, recipients, addresses, domains));

        const verdicts = recipients.map((r): GuardVerdict => {
            const base = { address: r.address, personId: r.personId, field: r.field };
            const s = suppressed.get(r.address);
            if (s) {
                return {
                    ...base,
                    outcome: 'blocked',
                    kind: 'suppressed',
                    suppression: s.reason,
                    message: SUPPRESSION_REASON_LABELS[s.reason],
                };
            }
            const person = facts.personFor(r);
            const company = facts.companyFor(r, person);
            const personId = r.personId ?? person?.id ?? null;
            const ownsRecord =
                sender !== null && (person?.ownerId === sender || (company !== null && company.ownerId === sender));
            const wroteHere = facts.threadAddresses.has(r.address);

            const excluded = facts.excluded.get(r.address);
            if (excluded && (request.outreach || !(ownsRecord || wroteHere))) {
                return {
                    ...base,
                    personId,
                    companyId: company?.companyId ?? null,
                    outcome: 'blocked',
                    kind: excluded.reason === 'customer' ? 'excluded_customer' : 'excluded_account_managed',
                    message: exclusionMessage(excluded),
                    detail: { source: excluded.source },
                };
            }

            if (sender !== null) {
                const deal = company
                    ? facts.openDealsByCompany.get(company.companyId)?.find((d) => d.ownerId !== sender)
                    : undefined;
                const taken: Omit<GuardVerdict, 'outcome' | 'address' | 'personId'> | null = deal
                    ? {
                          kind: 'in_negotiation',
                          owner: { memberId: deal.ownerId, name: deal.ownerName },
                          companyId: company!.companyId,
                          message: `${deal.ownerName ?? 'Another member'} is negotiating with ${company!.companyName} (${deal.name}) — ask them to introduce you`,
                          detail: { dealId: deal.id },
                      }
                    : person?.ownerId && person.ownerId !== sender
                      ? {
                            kind: 'owned_by_other',
                            owner: { memberId: person.ownerId, name: person.ownerName },
                            companyId: company?.companyId ?? null,
                            message: `${person.ownerName ?? 'Another member'}’s lead — ask them to introduce you`,
                        }
                      : company?.ownerId && company.ownerId !== sender
                        ? {
                              kind: 'owned_by_other',
                              owner: { memberId: company.ownerId, name: company.ownerName },
                              companyId: company.companyId,
                              message: `${company.companyName} is ${company.ownerName ?? 'another member'}’s account — ask them to introduce you`,
                          }
                        : null;
                // A colleague's lead in a thread that colleague is on: answering it is not poaching.
                if (taken && !facts.threadMembers.has(taken.owner!.memberId)) {
                    return { ...base, personId, ...taken, outcome: exempt ? 'allowed' : 'blocked' };
                }

                if (request.path === 'sequence_enrol' && facts.warm.has(r.address)) {
                    const theirs = exempt || (person !== null && person.ownerId === sender);
                    const owner = person?.ownerId ? { memberId: person.ownerId, name: person.ownerName } : undefined;
                    return {
                        ...base,
                        personId,
                        companyId: company?.companyId ?? null,
                        owner,
                        outcome: theirs ? 'warned' : 'blocked',
                        kind: 'cold_to_known',
                        message: theirs
                            ? 'Already in a conversation with the workspace — a sequence will read as cold mail'
                            : `Already in a conversation with the workspace — only ${owner?.name ?? 'their owner'} or a manager may put them in a sequence`,
                    };
                }
            }
            return { ...base, personId, outcome: 'pass', message: '' };
        });

        if (request.record !== false) await this.record(context, request.path, verdicts);
        return verdicts;
    }

    /** The audit, and a member's third block on owned addresses today telling the reviewers (once a day). */
    private async record(
        context: WorkspaceRunContext,
        path: GuardPath,
        verdicts: readonly GuardVerdict[],
    ): Promise<void> {
        const kept = verdicts.filter((v) => v.outcome !== 'pass' && v.kind);
        if (kept.length === 0) return;
        const actor = context.memberId ?? null;
        try {
            await this.rls.withWorkspace(context.workspaceId, async (tx) => {
                await recordGuardrailEvents(
                    tx,
                    this.events,
                    context,
                    kept.map((v) => ({
                        kind: v.kind!,
                        outcome: v.outcome as GuardrailOutcome,
                        severity: v.outcome === 'allowed' ? 'low' : SEVERITY[v.kind!],
                        path,
                        actorMemberId: actor,
                        ownerMemberId: v.owner?.memberId ?? null,
                        personId: v.personId,
                        companyId: v.companyId ?? null,
                        address: v.address,
                        message: v.message,
                        detail: (v.detail ?? {}) as Prisma.InputJsonValue,
                    })),
                );
                const ownedBlocks = kept.some(
                    (v) => v.outcome === 'blocked' && OWNED_GUARDRAIL_KINDS.includes(v.kind!),
                );
                if (actor && ownedBlocks) await repeatBlocks(tx, this.events, context, actor);
            });
        } catch (error) {
            // The refusal stands whether or not its record was written; a lost row is logged, never sent.
            this.logger.error(
                `guardrail events not written: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }

    private widened<T>(context: WorkspaceRunContext, fn: (tx: WorkspaceClient) => Promise<T>): Promise<T> {
        const { ownerScopeMemberId: _scope, ...wide } = context;
        return this.context.run(wide, () => this.rls.withWorkspace(context.workspaceId, fn));
    }
}

interface PersonFact {
    id: string;
    ownerId: string | null;
    ownerName: string | null;
    companyId: string | null;
    address: string | null;
}

interface DealFact {
    id: string;
    name: string;
    ownerId: string;
    ownerName: string | null;
}

/** What the guard reads about the recipients, in one transaction outside the caller's record scope. */
async function readFacts(
    tx: WorkspaceClient,
    request: GuardRequest,
    recipients: readonly GuardRecipient[],
    addresses: readonly string[],
    domains: ReadonlyMap<string, DomainCompany | null>,
) {
    const excluded = await exclusionHits(tx, addresses);
    // Shared mailboxes own leads nobody is kept from: their people, companies and deals read as unowned.
    const shared = new Set((await guardrailSettings(tx)).sharedMailboxMemberIds);
    const unshared = (c: DomainCompany): DomainCompany =>
        c.ownerId !== null && shared.has(c.ownerId) ? { ...c, ownerId: null, ownerName: null } : c;
    const domainCompanies = new Map([...domains].map(([d, c]) => [d, c ? unshared(c) : null]));

    const ids = [...new Set(recipients.flatMap((r) => (r.personId ? [r.personId] : [])))];
    const people = await tx.person.findMany({
        where: { deletedAt: null, OR: [{ id: { in: ids } }, { emailPrimary: { in: [...addresses] } }] },
        select: { id: true, ownerId: true, companyId: true, emailPrimary: true, owner: NAMED },
        orderBy: { createdAt: 'asc' },
    });
    const facts: PersonFact[] = people.map((p) => ({
        id: p.id,
        ownerId: effectiveOwner(p.ownerId, shared),
        ownerName: effectiveOwner(p.ownerId, shared) ? (p.owner?.user.displayName ?? null) : null,
        companyId: p.companyId,
        address: p.emailPrimary,
    }));
    const byId = new Map(facts.map((p) => [p.id, p]));
    const byAddress = new Map<string, PersonFact>();
    for (const p of facts) if (p.address && !byAddress.has(p.address)) byAddress.set(p.address, p);

    // The companies people are linked to, beside those found by domain.
    const linkedIds = [...new Set(facts.flatMap((p) => (p.companyId ? [p.companyId] : [])))];
    const linked = await tx.company.findMany({
        where: { id: { in: linkedIds }, deletedAt: null },
        select: { id: true, name: true, ownerId: true, owner: NAMED },
    });
    const companies = new Map<string, DomainCompany>(
        linked.map((c) => [
            c.id,
            unshared({
                companyId: c.id,
                companyName: c.name,
                ownerId: c.ownerId,
                ownerName: c.owner?.user.displayName ?? null,
            }),
        ]),
    );
    for (const c of domainCompanies.values()) if (c) companies.set(c.companyId, c);

    const deals = await tx.opportunity.findMany({
        where: {
            companyId: { in: [...companies.keys()] },
            deletedAt: null,
            closedAt: null,
            ownerId: { not: null, notIn: [...shared] },
            stage: { kind: 'open' },
        },
        select: { id: true, name: true, companyId: true, ownerId: true, owner: NAMED },
        orderBy: { createdAt: 'asc' },
    });
    const openDealsByCompany = new Map<string, DealFact[]>();
    for (const d of deals) {
        const list = openDealsByCompany.get(d.companyId!) ?? [];
        list.push({ id: d.id, name: d.name, ownerId: d.ownerId!, ownerName: d.owner?.user.displayName ?? null });
        openDealsByCompany.set(d.companyId!, list);
    }

    // A reply: who (members) and which addresses already wrote in the thread it answers.
    const threadMembers = new Set<string>();
    const threadAddresses = new Set<string>();
    if (request.replyToMessageId) {
        const parent = await tx.mailMessage.findUnique({
            where: { id: request.replyToMessageId },
            select: { threadId: true },
        });
        if (parent) {
            const participants = await tx.mailParticipant.findMany({
                where: { message: { threadId: parent.threadId } },
                select: { role: true, address: true, memberId: true },
            });
            for (const p of participants) {
                if (p.memberId) threadMembers.add(p.memberId);
                if (p.role === 'from') threadAddresses.add(p.address.toLowerCase());
            }
        }
    }

    // Warm contacts (an enrolment only): an address that wrote in a thread the workspace also wrote in.
    const warm = new Set<string>();
    if (request.path === 'sequence_enrol') {
        const rows = await tx.$queryRaw<{ address: string }[]>`
            SELECT DISTINCT lower(i.from_address) AS address
            FROM mail_messages i
            WHERE i.direction = 'inbound'
              AND lower(i.from_address) = ANY(${[...addresses]}::text[])
              AND EXISTS (SELECT 1 FROM mail_messages o WHERE o.thread_id = i.thread_id AND o.direction = 'outbound')
        `;
        for (const r of rows) warm.add(r.address);
    }

    return {
        excluded,
        openDealsByCompany,
        threadMembers,
        threadAddresses,
        warm,
        personFor(r: GuardRecipient): PersonFact | null {
            return (r.personId ? byId.get(r.personId) : undefined) ?? byAddress.get(r.address) ?? null;
        },
        companyFor(r: GuardRecipient, person: PersonFact | null): DomainCompany | null {
            const domain = companyDomainOfAddress(r.address);
            return (
                (person?.companyId ? companies.get(person.companyId) : undefined) ??
                (domain ? domainCompanies.get(domain) : null) ??
                null
            );
        },
    };
}

/**
 * The member's blocks on owned addresses today (UTC): at the third, one `repeat_blocks` event (its key makes it
 * once a day) and a `guardrail_repeat_blocks` notification to every reviewer — members whose role has
 * `guardrail:review`, and admins — but never the member themselves.
 */
async function repeatBlocks(
    tx: WorkspaceClient,
    events: DomainEvents,
    context: WorkspaceRunContext,
    actor: string,
): Promise<void> {
    const workspaceId = context.workspaceId;
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    const since = new Date(`${day}T00:00:00.000Z`);
    const count = await tx.guardrailEvent.count({
        where: {
            actorMemberId: actor,
            outcome: 'blocked',
            kind: { in: [...OWNED_GUARDRAIL_KINDS] },
            createdAt: { gte: since },
        },
    });
    if (count < GUARDRAIL_REPEAT_BLOCKS_PER_DAY) return;
    const reviewers = await reviewersIn(tx, actor);
    const actorName =
        (await tx.workspaceMember.findUnique({ where: { id: actor }, select: NAMED.select }))?.user.displayName ??
        'A member';
    const [event] = await recordGuardrailEvents(
        tx,
        events,
        context,
        [
            {
                kind: 'repeat_blocks',
                outcome: 'warned',
                severity: 'high',
                path: 'repeat_blocks',
                actorMemberId: actor,
                message: `${actorName} was stopped ${count} times today from mailing other members’ leads`,
                detail: { count: String(count), day },
                notifiedMemberIds: reviewers,
                dedupeKey: `repeat_blocks:${actor}:${day}`,
            },
        ],
        true,
    );
    if (!event || reviewers.length === 0) return;
    await tx.notification.createMany({
        data: reviewers.map((memberId) => ({
            workspaceId,
            memberId,
            kind: 'guardrail_repeat_blocks' as const,
            guardrailEventId: event.id,
        })),
        skipDuplicates: true,
    });
}

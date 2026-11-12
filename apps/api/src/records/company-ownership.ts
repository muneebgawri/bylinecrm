import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
    DORMANT_OWNER_MONTHS_DEFAULT,
    bareDomain,
    type CompanyOwnedDetails,
    type DomainEvent,
    type Emails,
    type OwnershipConflictView,
} from '@bylinecrm/shared';
import { isFreeMailDomain } from '../enrichment/email-domain';
import { DomainEvents } from '../events/domain-events.service';
import { effectiveOwner, guardrailSettings, ownerlessMembers } from '../guardrails/guardrail-settings';
import { companyDomain } from './company-domain';
import { ApiException } from '../infra/errors/api-errors';
import { RlsPrismaService, type WorkspaceClient } from '../infra/rls-prisma.service';
import { WorkspaceContext, type WorkspaceRunContext } from '../infra/workspace-context';
import { actorOf } from './actor';
import { acrossOwnerScope } from './record-scope';

/** A company found by a domain, with who owns it. */
export interface DomainCompany {
    companyId: string;
    companyName: string;
    /**
     * Who owns it: the company's own owner, else (OWN-2d) the owner of the first person saved at it — the Bigin
     * import set owners on people, not on their companies. A member who has left, or a shared mailbox, owns
     * nothing here, as for the guard (`ownerlessMembers`). Null for nobody's.
     */
    ownerId: string | null;
    ownerName: string | null;
    /**
     * True when a governed save at it claims it for the saver: the row names no owner (OWN-2d), or its owner has not
     * worked it in the workspace's `dormantOwnerMonths` (OWN-2f, `dormantOwnerId`).
     */
    unclaimed: boolean;
    /** OWN-2f: the owner the row names who has not worked it in `dormantOwnerMonths`, and so holds it for nobody. */
    dormantOwnerId?: string;
}

/** OWN-2g: the leads at a domain with no company yet, and who holds the domain through them. */
export interface DomainLeads {
    personIds: string[];
    holder: { ownerId: string; ownerName: string | null } | null;
}

const NAMED_MEMBER = { user: { select: { displayName: true } } } as const;

/** What is read of a company to say whose it is. */
const COMPANY_OWNER_SELECT = {
    id: true,
    name: true,
    ownerId: true,
    owner: { select: { user: { select: { displayName: true } } } },
} as const;

export interface CompanyOwnerRow {
    id: string;
    name: string;
    ownerId: string | null;
    owner: { user: { displayName: string | null } } | null;
}

/**
 * The company domain of an address — its registrable domain (`dana@eu.acme.com` is at `acme.com`); null for no
 * address, a malformed one, or free mail.
 */
export function companyDomainOfAddress(address: string | null | undefined): string | null {
    if (!address) return null;
    const at = address.lastIndexOf('@');
    const domain = companyDomain(at > 0 ? address.slice(at + 1) : '');
    if (!domain || isFreeMailDomain(domain)) return null;
    return domain;
}

/** A domain as a company stores it (OWN-2c): its registrable domain, else the bare host. */
export function normalisedDomain(value: string): string {
    return companyDomain(value) ?? bareDomain(value);
}

/**
 * Company-domain ownership (OWN-2, #201, FR-CRMS-20). The member who owns a company owns every person at
 * it and every deal with it, so the first to save a company — or the first person at it — keeps its
 * leads. The record services ask this before they write:
 *
 * - **Who owns a domain** is read across the whole workspace, whatever the caller's owner scope: an
 *   account manager who sees only their own records must still be told, by name, that a lead is someone
 *   else's (that is the point; nothing else of the company is shown).
 * - **The rule applies to people and API keys**, never to a job (sync, import) acting for the workspace,
 *   and never to a holder of `record:transfer`, who places records where they choose.
 * - **A company nobody owns is its first saver's** (OWN-2d). The owner of a company whose row names none is
 *   read from its people — the owner of the earliest person saved at it — and a governed save of a person
 *   at a company with no owner claims it, in the same transaction, for the person's owner. So an imported
 *   company (owners on its people, none on it) is held like one saved here, from the first save on.
 *   `assign-company-owners.js` fills the imported ones in batches.
 * - **An owner who stops working a company lets it go** (OWN-2f). An owner with no open deal at it, no mail to
 *   anyone there and nothing done on it or its people in the workspace's `dormantOwnerMonths` (Settings →
 *   Ownership; 0 is off) holds it for nobody: its leads
 *   are anyone's to mail and save, and the next governed save of a person there takes the company over.
 */
@Injectable()
export class CompanyOwnership {
    constructor(
        private readonly rls: RlsPrismaService,
        private readonly context: WorkspaceContext,
        private readonly events: DomainEvents,
    ) {}

    /** The live company whose domain, or other domain, this is; null for none. */
    async companyForDomain(context: WorkspaceRunContext, domain: string | null): Promise<DomainCompany | null> {
        if (!domain) return null;
        // A company saved before OWN-2c may still read `www.<domain>`; the CLI rewrites the rest.
        const key = normalisedDomain(domain);
        const forms = [key, `www.${key}`];
        return this.widened(context, async (tx) => {
            const own = await tx.company.findFirst({
                where: { domain: { in: forms }, deletedAt: null },
                orderBy: { createdAt: 'asc' },
                select: COMPANY_OWNER_SELECT,
            });
            const company =
                own ??
                (
                    await tx.companyDomain.findFirst({
                        where: { domain: { in: forms }, company: { deletedAt: null } },
                        select: { company: { select: COMPANY_OWNER_SELECT } },
                    })
                )?.company;
            return company ? resolveCompanyOwner(tx, company) : null;
        });
    }

    /** The company a record names, with its owner, across the caller's scope; null when there is none. */
    async company(context: WorkspaceRunContext, companyId: string | null): Promise<DomainCompany | null> {
        if (!companyId) return null;
        return this.widened(context, async (tx) => {
            const c = await tx.company.findFirst({
                where: { id: companyId, deletedAt: null },
                select: COMPANY_OWNER_SELECT,
            });
            return c ? resolveCompanyOwner(tx, c) : null;
        });
    }

    /**
     * What a person being saved with `address` at `companyId` comes to: the company to link (theirs by
     * domain, when none was named) and, when that company is someone else's, a `409 conflict.company_owned`.
     * `ownerId` is the owner the write resolved to. A company nobody owns is claimed for that owner in `tx`,
     * the save's own transaction (OWN-2d), so it is theirs from this save on — or not at all, if the save
     * fails. Returns the company to link, if any.
     */
    async checkPerson(
        tx: WorkspaceClient,
        context: WorkspaceRunContext,
        input: { address: string | null | undefined; companyId: string | null | undefined; ownerId: string | null },
    ): Promise<{ companyId?: string; company: DomainCompany | null }> {
        if (!isGoverned(context)) return { company: null };
        const named = input.companyId ? await this.company(context, input.companyId) : null;
        const byDomain = named ? null : await this.companyForDomain(context, companyDomainOfAddress(input.address));
        const company = named ?? byDomain;
        if (!company) return { company: null };
        assertSameOwner(company, input.ownerId);
        if (company.unclaimed && input.ownerId) {
            await this.claim(tx, context, company.companyId, input.ownerId, company.dormantOwnerId ?? null);
        }
        return byDomain && input.companyId === undefined
            ? { companyId: byDomain.companyId, company: byDomain }
            : { company };
    }

    /**
     * Gives a company that has no owner to `memberId` (OWN-2d), in the caller's transaction, and records the
     * change (`company.updated`) — the one way a company's empty owner is filled: a governed save at it, the
     * hand-over of a lead to the owner its people name, and the `assign-company-owners.js` backfill. Runs past
     * the caller's owner scope (`claim_company`, a definer function: an own-scoped member cannot see a company
     * nobody owns). False when the company is gone, already someone's, or the member has left.
     */
    async claim(
        tx: WorkspaceClient,
        context: WorkspaceRunContext,
        companyId: string,
        memberId: string,
        /** OWN-2f: the dormant owner it is taken from; null for a company that names none. */
        from: string | null = null,
    ): Promise<boolean> {
        const [row] = await tx.$queryRaw<{ claimed: boolean }[]>`
            SELECT claim_company(${companyId}::uuid, ${memberId}::uuid, ${from}::uuid) AS claimed`;
        if (!row?.claimed) return false;
        const event: DomainEvent = {
            type: 'company.updated',
            object: 'company',
            workspaceId: context.workspaceId,
            actor: actorOf(context),
            occurredAt: new Date().toISOString(),
            recordId: companyId,
            diff: { ownerId: { from, to: memberId } },
        };
        await this.events.record(tx, event);
        return true;
    }

    /** A deal at `companyId` owned by `ownerId`: refused when the company is someone else's. */
    async checkDeal(context: WorkspaceRunContext, companyId: string | null, ownerId: string | null): Promise<void> {
        if (!isGoverned(context) || !companyId) return;
        const company = await this.company(context, companyId);
        if (company) assertSameOwner(company, ownerId);
    }

    /** A company being saved with `domain`: refused when another company has it as its own or other domain. */
    async checkCompanyDomain(
        context: WorkspaceRunContext,
        domain: string | null | undefined,
        selfId?: string,
    ): Promise<void> {
        if (!domain) return;
        // OWN-2c: compared by registrable domain — `uk.acme.com` is `acme.com`'s company.
        const company = await this.companyForDomain(context, normalisedDomain(domain));
        if (company && company.companyId !== selfId) throw companyOwned(company, 'domain');
    }

    /**
     * The records the rule disagrees with (the backfill report): people at an address whose company someone
     * else owns, and people or open deals linked to a company someone else owns. Read in the caller's scope.
     */
    async conflicts(tx: WorkspaceClient): Promise<OwnershipConflictView[]> {
        const rows = await tx.$queryRaw<
            {
                kind: OwnershipConflictView['kind'];
                object: 'person' | 'opportunity' | 'company';
                record_id: string;
                record_label: string;
                record_owner: string | null;
                record_owner_name: string | null;
                company_id: string;
                company_name: string;
                company_owner: string;
                company_owner_name: string | null;
            }[]
        >`
            WITH domains AS (
                SELECT c.id AS company_id, c.domain FROM companies c WHERE c.deleted_at IS NULL AND c.domain IS NOT NULL
                UNION ALL
                SELECT d.company_id, d.domain FROM company_domains d
            ),
            found AS (
                SELECT 'domain_owned_by_other'::text AS kind, 'person'::text AS object, p.id AS record_id,
                       trim(p.name_first || ' ' || p.name_last) AS record_label, p.owner_id AS record_owner, c.id AS company_id
                FROM people p
                JOIN domains d ON d.domain = split_part(p.email_primary, '@', 2)
                JOIN companies c ON c.id = d.company_id AND c.deleted_at IS NULL
                WHERE p.deleted_at IS NULL AND c.owner_id IS NOT NULL
                  AND p.owner_id IS DISTINCT FROM c.owner_id
                  AND (p.company_id IS NULL OR p.company_id <> c.id)
                UNION ALL
                SELECT 'company_owner_differs', 'person', p.id, trim(p.name_first || ' ' || p.name_last), p.owner_id, c.id
                FROM people p JOIN companies c ON c.id = p.company_id AND c.deleted_at IS NULL
                WHERE p.deleted_at IS NULL AND c.owner_id IS NOT NULL AND p.owner_id IS DISTINCT FROM c.owner_id
                UNION ALL
                SELECT 'company_owner_differs', 'opportunity', o.id, o.name, o.owner_id, c.id
                FROM opportunities o JOIN companies c ON c.id = o.company_id AND c.deleted_at IS NULL
                WHERE o.deleted_at IS NULL AND o.closed_at IS NULL AND c.owner_id IS NOT NULL
                  AND o.owner_id IS DISTINCT FROM c.owner_id
            )
            SELECT f.kind, f.object, f.record_id::text, coalesce(nullif(f.record_label, ''), 'Unnamed') AS record_label,
                   f.record_owner::text, ru.display_name AS record_owner_name,
                   c.id::text AS company_id, c.name AS company_name, c.owner_id::text AS company_owner,
                   cu.display_name AS company_owner_name
            FROM found f
            JOIN companies c ON c.id = f.company_id
            LEFT JOIN workspace_members rm ON rm.id = f.record_owner
            LEFT JOIN users ru ON ru.id = rm.user_id
            JOIN workspace_members cm ON cm.id = c.owner_id
            JOIN users cu ON cu.id = cm.user_id
            ORDER BY c.name, f.object, f.record_label
            LIMIT 1000
        `;
        const listed = rows.map((r) => ({
            kind: r.kind,
            object: r.object,
            recordId: r.record_id,
            recordLabel: r.record_label,
            recordOwnerMemberId: r.record_owner,
            recordOwnerName: r.record_owner_name,
            companyId: r.company_id,
            companyName: r.company_name,
            companyOwnerMemberId: r.company_owner,
            companyOwnerName: r.company_owner_name,
        }));
        return [...(await duplicateCompanies(tx)), ...listed];
    }

    /**
     * Who holds the person saved under this primary address, read like a domain's owner: across the caller's
     * scope, by name only. Trashed people count, as they do for the unique address. Null when there is none.
     */
    async addressHolder(
        context: WorkspaceRunContext,
        address: string | null | undefined,
        /** A person not to count: the one being restored, which holds its own address. */
        exceptPersonId?: string,
    ): Promise<{ ownerName: string | null; trashed: boolean; workspaceName: string | null } | null> {
        if (!address) return null;
        const email = address.trim().toLowerCase();
        return this.widened(context, async (tx) => {
            // Its primary address or an additional one (`person_addresses`): one person per address, either way.
            const person = await tx.person.findFirst({
                where: {
                    OR: [{ emailPrimary: email }, { addresses: { some: { address: email } } }],
                    ...(exceptPersonId ? { id: { not: exceptPersonId } } : {}),
                },
                select: { deletedAt: true, owner: { select: { user: { select: { displayName: true } } } } },
            });
            if (person) {
                return {
                    ownerName: person.owner?.user.displayName ?? null,
                    trashed: person.deletedAt !== null,
                    workspaceName: null,
                };
            }
            // A workspace sharing this one's lead pool, with the person as a customer or prospect: only its name is told.
            const pooled = (await poolHoldersIn(tx, [email])).get(email);
            return pooled ? { ownerName: null, trashed: false, workspaceName: pooled } : null;
        });
    }

    /**
     * Of these (normalised) addresses, those another workspace of this one's lead pool has as a customer or
     * prospect, each to that workspace's name — all that is told of it. Empty for a workspace in no pool.
     */
    poolHolders(context: WorkspaceRunContext, addresses: readonly string[]): Promise<Map<string, string>> {
        if (addresses.length === 0) return Promise.resolve(new Map());
        return this.widened(context, (tx) => poolHoldersIn(tx, addresses));
    }

    /**
     * OWN-2g: the live leads saved at `domain` that no company holds yet (saved before its company was), and the
     * member who holds the domain through them: the owner of the earliest, passing over a member who holds nothing
     * (OWN-2e) and one who has not worked their leads there in the workspace's months (OWN-2f). Read across the
     * owner scope. Nothing for no domain or free mail.
     */
    async domainLeads(context: WorkspaceRunContext, domain: string | null | undefined): Promise<DomainLeads> {
        const key = domain ? normalisedDomain(domain) : null;
        if (!key || isFreeMailDomain(key)) return { personIds: [], holder: null };
        return this.widened(context, async (tx) => {
            const rows = await tx.$queryRaw<{ id: string; email: string; owner_id: string | null }[]>`
                SELECT p.id::text AS id, p.email_primary AS email, p.owner_id::text AS owner_id
                FROM people p
                WHERE p.company_id IS NULL AND p.deleted_at IS NULL
                  AND (p.email_primary LIKE ${`%@${key}`} OR p.email_primary LIKE ${`%.${key}`})
                ORDER BY p.created_at, p.id`;
            const leads = rows.filter((r) => companyDomainOfAddress(r.email) === key);
            const ownerless = await ownerlessMembers(tx, await guardrailSettings(tx));
            const since = await dormantSince(tx);
            const owners = [...new Set(leads.flatMap((r) => (r.owner_id ? [r.owner_id] : [])))];
            for (const ownerId of owners) {
                if (ownerless.has(ownerId)) continue;
                const theirs = leads.filter((r) => r.owner_id === ownerId).map((r) => r.id);
                if (since && !(await ownerWorkedPeople(tx, theirs, ownerId, since))) continue;
                const member = await tx.workspaceMember.findFirst({ where: { id: ownerId }, select: NAMED_MEMBER });
                return {
                    personIds: leads.map((r) => r.id),
                    holder: { ownerId, ownerName: member?.user.displayName ?? null },
                };
            }
            return { personIds: leads.map((r) => r.id), holder: null };
        });
    }

    /**
     * OWN-2g: links `personIds` (leads with no company, read by `domainLeads`) to `companyId`, in the caller's
     * transaction and past their owner scope (`link_company_people`, a definer function: a member links a
     * colleague's lead at the company they save). Only the link changes; whose each lead is does not.
     */
    async linkPeople(tx: WorkspaceClient, companyId: string, personIds: readonly string[]): Promise<number> {
        if (personIds.length === 0) return 0;
        const [row] = await tx.$queryRaw<{ linked: number }[]>`
            SELECT link_company_people(${companyId}::uuid, ${[...personIds]}::uuid[]) AS linked`;
        return row?.linked ?? 0;
    }

    private widened<T>(context: WorkspaceRunContext, fn: (tx: WorkspaceClient) => Promise<T>): Promise<T> {
        return acrossOwnerScope(this.rls, this.context, context, fn);
    }
}

/** A person or an API key, as opposed to a job (sync, import) acting for the workspace. */
export function isCaller(context: WorkspaceRunContext): boolean {
    return context.memberId !== undefined || context.apiKeyId !== undefined;
}

/** The rule binds a person or an API key without `record:transfer`; never a job. */
export function isGoverned(context: WorkspaceRunContext): boolean {
    const caller = context.memberId !== undefined || context.apiKeyId !== undefined;
    return caller && !context.capabilities.has('record:transfer');
}

function assertSameOwner(company: DomainCompany, ownerId: string | null): void {
    if (company.ownerId !== null && company.ownerId !== ownerId) throw companyOwned(company, 'companyId');
}

export function companyOwned(company: DomainCompany, field: string): ApiException {
    const name = company.ownerName ?? 'another member';
    const details: CompanyOwnedDetails = {
        companyId: company.companyId,
        companyName: company.companyName,
        ownerMemberId: company.ownerId ?? '',
        ownerName: name,
    };
    return new ApiException(
        409,
        'conflict.company_owned',
        `${company.companyName} is ${name}’s: its people and deals are theirs. Save it for them instead.`,
        [{ path: field, message: 'COMPANY_OWNED' }],
        details,
    );
}

/**
 * OWN-2g: `409 conflict.company_owned` for a company not saved yet — its domain is `holder`'s through leads they saved
 * there first. As `companyOwned`, without a `companyId`: the rep may save the lead for them instead.
 */
export function domainHeld(
    companyName: string,
    holder: NonNullable<DomainLeads['holder']>,
    field: string,
): ApiException {
    const name = holder.ownerName ?? 'another member';
    return new ApiException(
        409,
        'conflict.company_owned',
        `${companyName} is ${name}’s: they saved a lead there first. Save it for them instead.`,
        [{ path: field, message: 'COMPANY_OWNED' }],
        { companyName, ownerMemberId: holder.ownerId, ownerName: name },
    );
}

/** The primary address of an `emails` value. */
export function primaryOf(emails: Emails | null | undefined): string | null {
    return emails?.primary ?? null;
}

/**
 * A company with whose it is (OWN-2d): its own owner, else the owner of the earliest live person saved at it — the
 * first saver, whom the import left on the people and not on the company. Read in `tx`, across the owner scope.
 */
export async function resolveCompanyOwner(tx: WorkspaceClient, company: CompanyOwnerRow): Promise<DomainCompany> {
    const base = { companyId: company.id, companyName: company.name, unclaimed: company.ownerId === null };
    // A member who has left, or a shared mailbox, keeps nobody from a company: its leads are anyone's, as they are
    // to the recipient guard. The row's owner is not changed; a company with none is still claimed by its next saver.
    const ownerless = await ownerlessMembers(tx, await guardrailSettings(tx));
    if (company.ownerId !== null) {
        if (effectiveOwner(company.ownerId, ownerless) === null) return { ...base, ownerId: null, ownerName: null };
        // OWN-2f: an owner who has not worked the company in the workspace's months holds it for nobody; the next
        // governed save at it takes it over.
        const since = await dormantSince(tx);
        if (since && !(await ownerWorkedCompany(tx, company.id, company.ownerId, since))) {
            return { ...base, ownerId: null, ownerName: null, unclaimed: true, dormantOwnerId: company.ownerId };
        }
        return { ...base, ownerId: company.ownerId, ownerName: company.owner?.user.displayName ?? null };
    }
    const first = await tx.person.findFirst({
        where: { companyId: company.id, deletedAt: null, ownerId: { not: null, notIn: [...ownerless] } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { ownerId: true, owner: { select: { user: { select: { displayName: true } } } } },
    });
    return { ...base, ownerId: first?.ownerId ?? null, ownerName: first?.owner?.user.displayName ?? null };
}

/** OWN-2f: the workspace's months an owner may leave a company untouched and keep it (Settings → Ownership). */
export async function dormantOwnerMonths(tx: WorkspaceClient): Promise<number> {
    const row = await tx.ownershipSettings.findFirst({ select: { dormantOwnerMonths: true } });
    return row?.dormantOwnerMonths ?? DORMANT_OWNER_MONTHS_DEFAULT;
}

/**
 * OWN-2f: the start of the window an owner must have worked a company in to keep it; null when the workspace has
 * turned the rule off (0 months).
 */
export async function dormantSince(tx: WorkspaceClient, now: Date = new Date()): Promise<Date | null> {
    const months = await dormantOwnerMonths(tx);
    if (months === 0) return null;
    const since = new Date(now);
    since.setUTCMonth(since.getUTCMonth() - months);
    return since;
}

/**
 * OWN-2f: whether `ownerId` has worked `companyId` since `since` — an open deal with it is theirs, the company or a
 * person of theirs at it was saved (read from the rows, so a save counts before its timeline entry is written; a lead
 * dealt to them by an intake counts, an import does not), a member handed it to them (a backfill's fill, from nobody,
 * does not), they mailed
 * someone at it, or the timeline shows them acting on it or on someone at it (a call, a note, a change). What an
 * import or a sync wrote in their name does not count. Read in `tx` across the owner scope.
 */
export async function ownerWorkedCompany(
    tx: WorkspaceClient,
    companyId: string,
    ownerId: string,
    since: Date,
): Promise<boolean> {
    const [row] = await tx.$queryRaw<{ worked: boolean }[]>`
        SELECT EXISTS (
                   SELECT 1 FROM opportunities d
                   WHERE d.company_id = ${companyId}::uuid AND d.owner_id = ${ownerId}::uuid
                     AND d.deleted_at IS NULL AND d.closed_at IS NULL)
            OR EXISTS (
                   SELECT 1 FROM companies c
                   WHERE c.id = ${companyId}::uuid AND c.created_at >= ${since} AND c.created_by ->> 'kind' <> 'import')
            OR EXISTS (
                   SELECT 1 FROM ownership_transfers o
                   WHERE o.object = 'company' AND o.record_id = ${companyId}::uuid AND o.to_member_id = ${ownerId}::uuid
                     AND o.status IN ('accepted', 'forced') AND o.from_member_id IS NOT NULL
                     AND o.decided_at >= ${since})
            OR EXISTS (
                   SELECT 1 FROM timeline_activities t
                   WHERE t.workspace_id = app_workspace_id() AND t.target_id = ${companyId}::uuid
                     AND t.target_type = 'company' AND t.happened_at >= ${since}
                     AND t.actor ->> 'kind' = 'member' AND t.actor ->> 'id' = ${ownerId})
            OR ${workedPeopleSql(Prisma.sql`p.company_id = ${companyId}::uuid`, ownerId, since)}
               AS worked`;
    return row?.worked ?? false;
}

/**
 * OWN-2f, for people with no company yet (leads saved at a domain before its company was): whether `ownerId` has
 * worked any of `personIds` since `since` — the person half of `ownerWorkedCompany`.
 */
export async function ownerWorkedPeople(
    tx: WorkspaceClient,
    personIds: readonly string[],
    ownerId: string,
    since: Date,
): Promise<boolean> {
    if (personIds.length === 0) return false;
    const [row] = await tx.$queryRaw<{ worked: boolean }[]>`
        SELECT ${workedPeopleSql(Prisma.sql`p.id = ANY(${[...personIds]}::uuid[])`, ownerId, since)} AS worked`;
    return row?.worked ?? false;
}

/**
 * The person half of OWN-2f's reading, for the live people `which` selects (alias `p`): one of them saved since
 * `since` for or by `ownerId` (not by an import), mailed by them, or acted on by them on the timeline.
 */
function workedPeopleSql(which: Prisma.Sql, ownerId: string, since: Date): Prisma.Sql {
    return Prisma.sql`(
        EXISTS (
            SELECT 1 FROM people p
            WHERE ${which} AND p.deleted_at IS NULL AND p.created_at >= ${since}
              AND p.created_by ->> 'kind' <> 'import'
              AND (p.owner_id = ${ownerId}::uuid OR p.created_by ->> 'id' = ${ownerId}))
        OR EXISTS (
            SELECT 1 FROM people p
            JOIN mail_participants mp ON mp.workspace_id = p.workspace_id AND mp.person_id = p.id
            JOIN mail_messages mm ON mm.id = mp.message_id AND mm.direction = 'outbound' AND mm.sent_at >= ${since}
            JOIN mail_participants sp ON sp.message_id = mm.id AND sp.role = 'from' AND sp.member_id = ${ownerId}::uuid
            WHERE ${which} AND p.deleted_at IS NULL)
        OR EXISTS (
            SELECT 1 FROM people p
            JOIN timeline_activities t ON t.workspace_id = p.workspace_id AND t.target_id = p.id
             AND t.target_type = 'person' AND t.happened_at >= ${since}
            WHERE ${which} AND p.deleted_at IS NULL
              AND t.actor ->> 'kind' = 'member' AND t.actor ->> 'id' = ${ownerId}))`;
}

/**
 * OWN-2c: companies saved twice before domains were compared by registrable domain — `uk.acme.com` beside
 * `acme.com`. Grouped in code (the Public Suffix List is not in SQL); in each group the company already on the
 * registrable domain (else the oldest) is kept, and every other is listed for a person to merge or delete.
 */
async function duplicateCompanies(tx: WorkspaceClient): Promise<OwnershipConflictView[]> {
    const companies = await tx.company.findMany({
        where: { deletedAt: null, domain: { not: null } },
        select: {
            id: true,
            name: true,
            domain: true,
            ownerId: true,
            owner: { select: { user: { select: { displayName: true } } } },
        },
        orderBy: { createdAt: 'asc' },
    });
    const groups = new Map<string, typeof companies>();
    for (const c of companies) {
        const key = companyDomain(c.domain);
        if (key) groups.set(key, [...(groups.get(key) ?? []), c]);
    }
    const out: OwnershipConflictView[] = [];
    for (const [key, group] of groups) {
        if (group.length < 2) continue;
        const kept = group.find((c) => c.domain === key) ?? group[0]!;
        if (!kept.ownerId) continue;
        for (const dup of group) {
            if (dup.id === kept.id) continue;
            out.push({
                kind: 'duplicate_domain',
                object: 'company',
                recordId: dup.id,
                recordLabel: dup.name,
                recordOwnerMemberId: dup.ownerId,
                recordOwnerName: dup.owner?.user.displayName ?? null,
                companyId: kept.id,
                companyName: kept.name,
                companyOwnerMemberId: kept.ownerId,
                companyOwnerName: kept.owner?.user.displayName ?? null,
            });
        }
    }
    return out;
}

/**
 * Of these (normalised) addresses, those another workspace of the caller's lead pool holds as a customer or prospect,
 * each to that workspace's name, in the caller's transaction. Empty for a workspace in no pool.
 */
export async function poolHoldersIn(tx: WorkspaceClient, addresses: readonly string[]): Promise<Map<string, string>> {
    const rows = await tx.$queryRaw<{ email: string; name: string }[]>`
        SELECT email, workspace_name AS name FROM lead_pool_holders(${[...addresses]}::text[])`;
    return new Map(rows.map((r) => [r.email, r.name] as const));
}

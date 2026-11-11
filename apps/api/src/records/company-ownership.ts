import { Injectable } from '@nestjs/common';
import {
    bareDomain,
    type CompanyOwnedDetails,
    type DomainEvent,
    type Emails,
    type OwnershipConflictView,
} from '@bylinecrm/shared';
import { isFreeMailDomain } from '../enrichment/email-domain';
import { DomainEvents } from '../events/domain-events.service';
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
     * import set owners on people, not on their companies. Null for nobody's.
     */
    ownerId: string | null;
    ownerName: string | null;
    /** True when the company row itself names no owner: a governed save at it claims it for its owner (OWN-2d). */
    unclaimed: boolean;
}

/** What is read of a company to say whose it is. */
const COMPANY_OWNER_SELECT = {
    id: true,
    name: true,
    ownerId: true,
    owner: { select: { user: { select: { displayName: true } } } },
} as const;

interface CompanyOwnerRow {
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
            return company ? resolved(tx, company) : null;
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
            return c ? resolved(tx, c) : null;
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
        if (!governed(context)) return { company: null };
        const named = input.companyId ? await this.company(context, input.companyId) : null;
        const byDomain = named ? null : await this.companyForDomain(context, companyDomainOfAddress(input.address));
        const company = named ?? byDomain;
        if (!company) return { company: null };
        assertSameOwner(company, input.ownerId);
        if (company.unclaimed && input.ownerId) await this.claim(tx, context, company.companyId, input.ownerId);
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
    ): Promise<boolean> {
        const [row] = await tx.$queryRaw<{ claimed: boolean }[]>`
            SELECT claim_company(${companyId}::uuid, ${memberId}::uuid) AS claimed`;
        if (!row?.claimed) return false;
        const event: DomainEvent = {
            type: 'company.updated',
            object: 'company',
            workspaceId: context.workspaceId,
            actor: actorOf(context),
            occurredAt: new Date().toISOString(),
            recordId: companyId,
            diff: { ownerId: { from: null, to: memberId } },
        };
        await this.events.record(tx, event);
        return true;
    }

    /** A deal at `companyId` owned by `ownerId`: refused when the company is someone else's. */
    async checkDeal(context: WorkspaceRunContext, companyId: string | null, ownerId: string | null): Promise<void> {
        if (!governed(context) || !companyId) return;
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

    private widened<T>(context: WorkspaceRunContext, fn: (tx: WorkspaceClient) => Promise<T>): Promise<T> {
        return acrossOwnerScope(this.rls, this.context, context, fn);
    }
}

/** A person or an API key, as opposed to a job (sync, import) acting for the workspace. */
export function isCaller(context: WorkspaceRunContext): boolean {
    return context.memberId !== undefined || context.apiKeyId !== undefined;
}

/** The rule binds a person or an API key without `record:transfer`; never a job. */
function governed(context: WorkspaceRunContext): boolean {
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

/** The primary address of an `emails` value. */
export function primaryOf(emails: Emails | null | undefined): string | null {
    return emails?.primary ?? null;
}

/**
 * A company with whose it is (OWN-2d): its own owner, else the owner of the earliest live person saved at it — the
 * first saver, whom the import left on the people and not on the company. Read in `tx`, across the owner scope.
 */
async function resolved(tx: WorkspaceClient, company: CompanyOwnerRow): Promise<DomainCompany> {
    const base = { companyId: company.id, companyName: company.name, unclaimed: company.ownerId === null };
    if (company.ownerId !== null) {
        return { ...base, ownerId: company.ownerId, ownerName: company.owner?.user.displayName ?? null };
    }
    const first = await tx.person.findFirst({
        where: { companyId: company.id, deletedAt: null, ownerId: { not: null } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { ownerId: true, owner: { select: { user: { select: { displayName: true } } } } },
    });
    return { ...base, ownerId: first?.ownerId ?? null, ownerName: first?.owner?.user.displayName ?? null };
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

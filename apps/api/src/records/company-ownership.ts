import { Injectable } from '@nestjs/common';
import type { CompanyOwnedDetails, Emails, OwnershipConflictView } from '@bylinecrm/shared';
import { isFreeMailDomain } from '../enrichment/email-domain';
import { ApiException } from '../infra/errors/api-errors';
import { RlsPrismaService, type WorkspaceClient } from '../infra/rls-prisma.service';
import { WorkspaceContext, type WorkspaceRunContext } from '../infra/workspace-context';

/** A company found by a domain, with who owns it. */
export interface DomainCompany {
    companyId: string;
    companyName: string;
    ownerId: string | null;
    ownerName: string | null;
}

/** The domain of an address, lower case; null for no address, a malformed one, or free mail. */
export function companyDomainOfAddress(address: string | null | undefined): string | null {
    if (!address) return null;
    const at = address.lastIndexOf('@');
    const domain =
        at > 0
            ? address
                  .slice(at + 1)
                  .trim()
                  .toLowerCase()
            : '';
    if (!domain.includes('.') || isFreeMailDomain(domain)) return null;
    return domain;
}

/** A domain as a company stores it: lower case, no scheme, no `www.`, no path. */
export function normalisedDomain(value: string): string {
    return value
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//, '')
        .replace(/^www\./, '')
        .replace(/[/?#].*$/, '');
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
 */
@Injectable()
export class CompanyOwnership {
    constructor(
        private readonly rls: RlsPrismaService,
        private readonly context: WorkspaceContext,
    ) {}

    /** The live company whose domain, or other domain, this is; null for none. */
    async companyForDomain(context: WorkspaceRunContext, domain: string | null): Promise<DomainCompany | null> {
        if (!domain) return null;
        return this.widened(context, async (tx) => {
            const own = await tx.company.findFirst({
                where: { domain, deletedAt: null },
                select: {
                    id: true,
                    name: true,
                    ownerId: true,
                    owner: { select: { user: { select: { displayName: true } } } },
                },
            });
            const company =
                own ??
                (
                    await tx.companyDomain.findFirst({
                        where: { domain, company: { deletedAt: null } },
                        select: {
                            company: {
                                select: {
                                    id: true,
                                    name: true,
                                    ownerId: true,
                                    owner: { select: { user: { select: { displayName: true } } } },
                                },
                            },
                        },
                    })
                )?.company;
            return company
                ? {
                      companyId: company.id,
                      companyName: company.name,
                      ownerId: company.ownerId,
                      ownerName: company.owner?.user.displayName ?? null,
                  }
                : null;
        });
    }

    /** The company a record names, with its owner, across the caller's scope; null when there is none. */
    async company(context: WorkspaceRunContext, companyId: string | null): Promise<DomainCompany | null> {
        if (!companyId) return null;
        return this.widened(context, async (tx) => {
            const c = await tx.company.findFirst({
                where: { id: companyId, deletedAt: null },
                select: {
                    id: true,
                    name: true,
                    ownerId: true,
                    owner: { select: { user: { select: { displayName: true } } } },
                },
            });
            return c
                ? {
                      companyId: c.id,
                      companyName: c.name,
                      ownerId: c.ownerId,
                      ownerName: c.owner?.user.displayName ?? null,
                  }
                : null;
        });
    }

    /**
     * What a person being saved with `address` at `companyId` comes to: the company to link (theirs by
     * domain, when none was named) and, when that company is someone else's, a `409 conflict.company_owned`.
     * `ownerId` is the owner the write resolved to. Returns the company to link, if any.
     */
    async checkPerson(
        context: WorkspaceRunContext,
        input: { address: string | null | undefined; companyId: string | null | undefined; ownerId: string | null },
    ): Promise<{ companyId?: string; company: DomainCompany | null }> {
        if (!governed(context)) return { company: null };
        const named = input.companyId ? await this.company(context, input.companyId) : null;
        const byDomain = named ? null : await this.companyForDomain(context, companyDomainOfAddress(input.address));
        const company = named ?? byDomain;
        if (!company) return { company: null };
        assertSameOwner(company, input.ownerId);
        return byDomain && input.companyId === undefined
            ? { companyId: byDomain.companyId, company: byDomain }
            : { company };
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
                object: 'person' | 'opportunity';
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
        return rows.map((r) => ({
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
    }

    private widened<T>(context: WorkspaceRunContext, fn: (tx: WorkspaceClient) => Promise<T>): Promise<T> {
        const { ownerScopeMemberId: _scope, ...wide } = context;
        return this.context.run(wide, () => this.rls.withWorkspace(context.workspaceId, fn));
    }
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

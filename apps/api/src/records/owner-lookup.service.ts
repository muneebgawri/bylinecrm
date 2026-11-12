import { Injectable } from '@nestjs/common';
import { RlsPrismaService, type WorkspaceClient } from '../infra/rls-prisma.service';
import { WorkspaceContext } from '../infra/workspace-context';
import { effectiveOwner, guardrailSettings, ownerlessMembers } from '../guardrails/guardrail-settings';
import { CompanyOwnership, companyDomainOfAddress, normalisedDomain, type DomainCompany } from './company-ownership';
import { acrossOwnerScope } from './record-scope';

/** Who owns someone here, as an integration asks it (OWN-LOOKUP): the person, else their company. */
export interface OwnerLookup {
    /** A person with the address, or a company at the domain, is in the workspace. */
    found: boolean;
    /** Which record answered: the person, or the company whose owner owns them (OWN-2). Null when nothing was found. */
    match: 'person' | 'company' | null;
    recordId: string | null;
    recordName: string | null;
    /** The member who owns them, by their sign-in email; null when nobody does (or a left member / shared mailbox). */
    owner: { email: string; name: string | null } | null;
}

/**
 * WHO OWNS THIS PERSON OR COMPANY (OWN-LOOKUP; NewswireOS doc 11, "v2 → BylineCRM: who owns this person or
 * company"). NewswireOS asks it for a client who just signed up, and when someone presses "Check CRM", so its
 * dashboard can show the salesperson who has been working them.
 *
 * The answer is the one OWN-2 and the recipient guard (GUARD-1) give, read across the whole workspace whatever the
 * key's owner scope:
 * 1. the person with the address — primary or additional — and their owner;
 * 2. else, or when the person is nobody's, the company: the person's own, else the one at the domain (the address's
 *    registrable domain, or the `domain` asked about). A company's owner owns every person at it (OWN-2).
 * A member who has left, a shared mailbox (outreach@) or a dormant owner (OWN-2f) owns nothing: the answer is "no
 * owner", as for the guard. Read only: nothing is claimed, written or audited.
 */
@Injectable()
export class OwnerLookupService {
    constructor(
        private readonly rls: RlsPrismaService,
        private readonly context: WorkspaceContext,
        private readonly ownership: CompanyOwnership,
    ) {}

    async lookup(address: string, domain?: string | null): Promise<OwnerLookup> {
        const email = address.trim().toLowerCase();
        const context = this.context.get();
        if (!context) throw new Error('OwnerLookupService is used inside a workspace scope');
        const read = (fn: (tx: WorkspaceClient) => Promise<OwnerLookup>) =>
            acrossOwnerScope(this.rls, this.context, context, fn);

        const person = await read(async (tx) => {
            const shared = await ownerlessMembers(tx, await guardrailSettings(tx));
            const p = await tx.person.findFirst({
                where: {
                    deletedAt: null,
                    OR: [{ emailPrimary: email }, { addresses: { some: { address: email } } }],
                },
                orderBy: { createdAt: 'asc' },
                select: { id: true, nameFirst: true, nameLast: true, ownerId: true, companyId: true },
            });
            if (!p) return { found: false, match: null, recordId: null, recordName: null, owner: null };
            const ownerId = effectiveOwner(p.ownerId, shared);
            return {
                found: true,
                match: 'person',
                recordId: p.id,
                recordName: `${p.nameFirst} ${p.nameLast}`.trim() || null,
                owner: ownerId ? await memberOwner(tx, ownerId) : null,
                companyId: p.companyId,
            } as OwnerLookup & { companyId: string | null };
        });
        if (person.owner) return strip(person);

        // The company: the person's own, else the one at the domain asked about or the address's.
        const companyId = (person as { companyId?: string | null }).companyId ?? null;
        const atDomain = domain ? normalisedDomain(domain) : companyDomainOfAddress(email);
        const company: DomainCompany | null =
            (companyId ? await this.ownership.company(context, companyId) : null) ??
            (await this.ownership.companyForDomain(context, atDomain));
        if (company?.ownerId) {
            const owner = await read(async (tx) => {
                const shared = await ownerlessMembers(tx, await guardrailSettings(tx));
                const id = effectiveOwner(company.ownerId, shared);
                return {
                    found: true,
                    match: 'company',
                    recordId: company.companyId,
                    recordName: company.companyName,
                    owner: id ? await memberOwner(tx, id) : null,
                };
            });
            if (owner.owner) return owner;
        }
        if (person.found) return strip(person);
        return company
            ? {
                  found: true,
                  match: 'company',
                  recordId: company.companyId,
                  recordName: company.companyName,
                  owner: null,
              }
            : { found: false, match: null, recordId: null, recordName: null, owner: null };
    }
}

/** A member as an owner: their sign-in email and display name. */
async function memberOwner(tx: WorkspaceClient, memberId: string): Promise<OwnerLookup['owner']> {
    const m = await tx.workspaceMember.findUnique({
        where: { id: memberId },
        select: { user: { select: { email: true, displayName: true } } },
    });
    return m?.user.email ? { email: m.user.email.toLowerCase(), name: m.user.displayName ?? null } : null;
}

function strip(r: OwnerLookup & { companyId?: string | null }): OwnerLookup {
    const { companyId: _companyId, ...rest } = r;
    return rest;
}

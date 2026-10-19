import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { CompanyDomainView, OwnershipConflictView } from '@bylinecrm/shared';
import { requireCallerMember } from '../infra/caller-member';
import { UnknownReference } from '../infra/errors/api-errors';
import { RlsPrismaService } from '../infra/rls-prisma.service';
import { WorkspaceContext, type WorkspaceRunContext } from '../infra/workspace-context';
import { TransfersService } from '../transfers/transfers.service';
import { CompanyOwnership, normalisedDomain } from './company-ownership';
import { recordWhere } from './record-scope';

const DOMAIN = /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** OWN-2's routes: a company's other domains, and the backfill report. */
@Injectable()
export class OwnershipService {
    constructor(
        private readonly rls: RlsPrismaService,
        private readonly context: WorkspaceContext,
        private readonly ownership: CompanyOwnership,
        private readonly transfers: TransfersService,
    ) {}

    domains(companyId: string): Promise<CompanyDomainView[]> {
        const context = this.current();
        return this.rls.withWorkspace(async (tx) => {
            await this.company(context, companyId);
            const rows = await tx.companyDomain.findMany({ where: { companyId }, orderBy: { domain: 'asc' } });
            return rows.map((r) => ({ domain: r.domain, createdAt: r.createdAt.toISOString() }));
        });
    }

    async addDomain(companyId: string, raw: string): Promise<CompanyDomainView> {
        const context = this.current();
        const domain = normalisedDomain(raw);
        if (!DOMAIN.test(domain)) throw new UnknownReference('domain', 'not a domain, e.g. acme.co.uk');
        await this.assertMayEdit(context, companyId);
        await this.ownership.checkCompanyDomain(context, domain, companyId);
        return this.rls.withWorkspace(async (tx) => {
            const company = await tx.company.findUniqueOrThrow({ where: { id: companyId }, select: { domain: true } });
            if (company.domain === domain) throw new UnknownReference('domain', 'already the company’s own domain');
            const row = await tx.companyDomain.create({
                data: { workspaceId: context.workspaceId, companyId, domain },
            });
            return { domain: row.domain, createdAt: row.createdAt.toISOString() };
        });
    }

    async removeDomain(companyId: string, raw: string): Promise<void> {
        const context = this.current();
        await this.assertMayEdit(context, companyId);
        await this.rls.withWorkspace((tx) =>
            tx.companyDomain.deleteMany({ where: { companyId, domain: normalisedDomain(raw) } }),
        );
    }

    conflicts(): Promise<OwnershipConflictView[]> {
        return this.rls.withWorkspace((tx) => this.ownership.conflicts(tx));
    }

    /**
     * Resolves conflicts the report lists (OWN-2b): each named record moves to its company's owner — a forced
     * transfer, so both members are told — and a person not yet linked to the company is linked. Only rows the
     * report still lists are acted on; the rest come back as `skipped` (already resolved, or never a conflict).
     */
    async resolve(
        items: readonly { object: 'person' | 'opportunity'; recordId: string }[],
    ): Promise<{ resolved: string[]; skipped: string[] }> {
        const context = this.current();
        const current = await this.conflicts();
        const resolved: string[] = [];
        const skipped: string[] = [];
        for (const item of items) {
            const row = current.find((c) => c.object === item.object && c.recordId === item.recordId);
            // A duplicate company is merged or deleted by a person; moving it would not resolve anything.
            if (!row || row.object === 'company') {
                skipped.push(item.recordId);
                continue;
            }
            if (row.recordOwnerMemberId !== row.companyOwnerMemberId) {
                await this.transfers.propose({
                    object: row.object,
                    recordId: row.recordId,
                    toMemberId: row.companyOwnerMemberId,
                    reason: `Company ownership: ${row.companyName} is theirs`,
                });
            }
            if (row.object === 'person') {
                await this.rls.withWorkspace((tx) =>
                    tx.person.updateMany({
                        where: { id: row.recordId, companyId: null, ...recordWhere(context, false) },
                        data: { companyId: row.companyId },
                    }),
                );
            }
            resolved.push(row.recordId);
        }
        return { resolved, skipped };
    }

    /** The company, as the caller sees it. */
    private async company(context: WorkspaceRunContext, companyId: string) {
        const company = await this.rls.withWorkspace((tx) =>
            tx.company.findFirst({
                where: { id: companyId, ...recordWhere(context, false) },
                select: { ownerId: true },
            }),
        );
        if (!company) throw new NotFoundException('company not found');
        return company;
    }

    private async assertMayEdit(context: WorkspaceRunContext, companyId: string): Promise<void> {
        const company = await this.company(context, companyId);
        if (context.capabilities.has('record:transfer')) return;
        const me = await this.rls.withWorkspace((tx) => requireCallerMember(tx, context));
        if (company.ownerId !== null && company.ownerId !== me) {
            throw new ForbiddenException('only the company’s owner, or a manager, changes its domains');
        }
    }

    private current(): WorkspaceRunContext {
        const context = this.context.get();
        if (!context) throw new Error('OwnershipService is used inside a workspace scope');
        return context;
    }
}

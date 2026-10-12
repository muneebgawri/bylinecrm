import { Injectable } from '@nestjs/common';
import {
    DEFAULT_REGION_POLICY,
    REGION_CODES,
    REGION_POLICY_CHANGES_LIMIT,
    type RegionCode,
    type RegionPolicyChange,
    type RegionPolicyEntry,
} from '@bylinecrm/shared';
import { ValidationFailed } from '../infra/errors/api-errors';
import { RlsPrismaService, type WorkspaceClient } from '../infra/rls-prisma.service';
import { MEMBER_SUMMARY_SELECT } from '../records/summaries';
import { WorkspaceContext } from '../infra/workspace-context';

/**
 * The workspace's outreach policy per region (FR-CRMS-12): `DEFAULT_REGION_POLICY` (EU, UK and Canada
 * blocked — D-247) unless the workspace overrode a region. Opening a region blocked by default needs a
 * lawful basis, stated; the database checks the same. Every change is kept, with who made it (#141).
 */
@Injectable()
export class RegionPolicyService {
    constructor(
        private readonly rls: RlsPrismaService,
        private readonly context: WorkspaceContext,
    ) {}

    async list(): Promise<RegionPolicyEntry[]> {
        return this.rls.withWorkspace((tx) => this.entries(tx));
    }

    async set(input: { region: RegionCode; allowed: boolean; lawfulBasis?: string | null | undefined }) {
        const basis = input.lawfulBasis?.trim() || null;
        if (input.allowed && !DEFAULT_REGION_POLICY[input.region] && !basis) {
            throw new ValidationFailed('opening a region blocked by default needs your lawful basis', [
                { path: 'lawfulBasis', message: 'state the lawful basis for outreach to this region' },
            ]);
        }
        const memberId = this.context.get()?.memberId ?? null;
        return this.rls.withWorkspace(async (tx) => {
            const workspaceId = this.context.get()!.workspaceId;
            const lawfulBasis = input.allowed ? basis : null;
            const current = (await this.allowedIn(tx))[input.region];
            const stored = await tx.regionPolicy.findUnique({
                where: { workspaceId_region: { workspaceId, region: input.region } },
                select: { lawfulBasis: true },
            });
            // Setting a region to what it already is changes nothing and records nothing.
            if (current === input.allowed && (stored?.lawfulBasis ?? null) === lawfulBasis) return this.entries(tx);
            await tx.regionPolicyChange.create({
                data: {
                    workspaceId,
                    region: input.region,
                    allowed: input.allowed,
                    lawfulBasis,
                    changedByMemberId: memberId,
                },
            });
            await tx.regionPolicy.upsert({
                where: { workspaceId_region: { workspaceId, region: input.region } },
                create: {
                    workspaceId,
                    region: input.region,
                    allowed: input.allowed,
                    lawfulBasis,
                    updatedByMemberId: memberId,
                },
                update: { allowed: input.allowed, lawfulBasis, updatedByMemberId: memberId },
            });
            return this.entries(tx);
        });
    }

    /** The newest changes first, up to `REGION_POLICY_CHANGES_LIMIT`. */
    async changes(): Promise<RegionPolicyChange[]> {
        return this.rls.withWorkspace(async (tx) => {
            const rows = await tx.regionPolicyChange.findMany({
                orderBy: [{ changedAt: 'desc' }, { id: 'desc' }],
                take: REGION_POLICY_CHANGES_LIMIT,
                include: { changedBy: { select: MEMBER_SUMMARY_SELECT } },
            });
            return rows.map((row) => ({
                id: row.id,
                region: row.region,
                allowed: row.allowed,
                lawfulBasis: row.lawfulBasis,
                changedBy: row.changedBy?.user.displayName ?? null,
                changedAt: row.changedAt.toISOString(),
            }));
        });
    }

    /** The effective policy, region by region, read in `tx`. */
    async allowedIn(tx: WorkspaceClient): Promise<Record<RegionCode, boolean>> {
        const effective = { ...DEFAULT_REGION_POLICY };
        for (const row of await tx.regionPolicy.findMany()) effective[row.region] = row.allowed;
        return effective;
    }

    private async entries(tx: WorkspaceClient): Promise<RegionPolicyEntry[]> {
        const rows = new Map((await tx.regionPolicy.findMany()).map((r) => [r.region, r]));
        return REGION_CODES.map((region) => {
            const row = rows.get(region);
            return {
                region,
                allowed: row?.allowed ?? DEFAULT_REGION_POLICY[region],
                isDefault: !row || row.allowed === DEFAULT_REGION_POLICY[region],
                lawfulBasis: row?.lawfulBasis ?? null,
                updatedAt: row?.updatedAt.toISOString() ?? null,
            };
        });
    }
}

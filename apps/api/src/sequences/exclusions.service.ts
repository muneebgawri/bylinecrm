import { Injectable, NotFoundException } from '@nestjs/common';
import { normaliseSuppressionAddress, type ExclusionReason, type OutreachExclusionView } from '@bylinecrm/shared';
import type { OutreachExclusion } from '@prisma/client';
import { UniqueConflict } from '../infra/errors/api-errors';
import { uniqueViolation } from '../infra/prisma-errors';
import { RlsPrismaService, type WorkspaceClient } from '../infra/rls-prisma.service';
import { WorkspaceContext } from '../infra/workspace-context';

export interface ExclusionHit {
    reason: ExclusionReason;
    accountManagerName: string | null;
    source: string;
}

/**
 * Who outreach must never reach (FR-CRMS-10): customers and contacts an account manager works — by
 * address or by whole domain. Fed by the integration (P5-1, `source` its key) through the same routes a
 * workspace admin uses; checked at enrolment and before every step.
 */
@Injectable()
export class ExclusionsService {
    constructor(
        private readonly rls: RlsPrismaService,
        private readonly context: WorkspaceContext,
    ) {}

    async list(): Promise<OutreachExclusionView[]> {
        return this.rls.withWorkspace(async (tx) =>
            (await tx.outreachExclusion.findMany({ where: { removedAt: null }, orderBy: { createdAt: 'desc' } })).map(
                view,
            ),
        );
    }

    async add(input: {
        address?: string | null | undefined;
        domain?: string | null | undefined;
        reason: ExclusionReason;
        accountManagerName?: string | null | undefined;
        source?: string | undefined;
        externalRef?: string | null | undefined;
        note?: string | null | undefined;
    }): Promise<OutreachExclusionView> {
        const workspaceId = this.context.get()!.workspaceId;
        try {
            return await this.rls.withWorkspace(async (tx) =>
                view(
                    await tx.outreachExclusion.create({
                        data: {
                            workspaceId,
                            address: input.address ? normaliseSuppressionAddress(input.address) : null,
                            domain: input.domain?.trim().toLowerCase() || null,
                            reason: input.reason,
                            accountManagerName: input.accountManagerName ?? null,
                            source: input.source ?? 'manual',
                            externalRef: input.externalRef ?? null,
                            note: input.note ?? null,
                        },
                    }),
                ),
            );
        } catch (error) {
            if (uniqueViolation(error)) {
                throw new UniqueConflict(
                    'that address or domain is already excluded',
                    input.address ? 'address' : 'domain',
                );
            }
            throw error;
        }
    }

    async remove(id: string, note: string): Promise<void> {
        const changed = await this.rls.withWorkspace((tx) =>
            tx.outreachExclusion.updateMany({
                where: { id, removedAt: null },
                data: { removedAt: new Date(), removedNote: note },
            }),
        );
        if (changed.count === 0) throw new NotFoundException('exclusion not found');
    }

    /** The live exclusion for each address (by the address, else its domain), read in `tx`. */
    async check(tx: WorkspaceClient, addresses: readonly string[]): Promise<Map<string, ExclusionHit>> {
        const normalised = addresses.map((a) => a.toLowerCase());
        const domains = [...new Set(normalised.map((a) => a.slice(a.lastIndexOf('@') + 1)))];
        const rows = await tx.outreachExclusion.findMany({
            where: { removedAt: null, OR: [{ address: { in: normalised } }, { domain: { in: domains } }] },
        });
        const byAddress = new Map(rows.filter((r) => r.address).map((r) => [r.address!, r]));
        const byDomain = new Map(rows.filter((r) => r.domain).map((r) => [r.domain!, r]));
        const hits = new Map<string, ExclusionHit>();
        for (const address of normalised) {
            const row = byAddress.get(address) ?? byDomain.get(address.slice(address.lastIndexOf('@') + 1));
            if (row)
                hits.set(address, {
                    reason: row.reason,
                    accountManagerName: row.accountManagerName,
                    source: row.source,
                });
        }
        return hits;
    }
}

/** The refusal an exclusion gives, naming the rule (doc 50 §D). */
export function exclusionMessage(hit: ExclusionHit): string {
    if (hit.reason === 'account_managed') {
        return hit.accountManagerName
            ? `Worked by ${hit.accountManagerName} (account manager)`
            : 'Worked by an account manager';
    }
    return `Is a customer (${hit.source})`;
}

function view(row: OutreachExclusion): OutreachExclusionView {
    return {
        id: row.id,
        address: row.address,
        domain: row.domain,
        reason: row.reason,
        accountManagerName: row.accountManagerName,
        source: row.source,
        externalRef: row.externalRef,
        note: row.note,
        createdAt: row.createdAt.toISOString(),
    };
}

import { Injectable, NotFoundException } from '@nestjs/common';
import {
    normaliseEmail,
    type ExclusionReason,
    type ExclusionReviewReason,
    type OutreachExclusionView,
} from '@bylinecrm/shared';
import type { OutreachExclusion } from '@prisma/client';
import { UniqueConflict, ValidationFailed } from '../infra/errors/api-errors';
import { uniqueViolation } from '../infra/prisma-errors';
import { RlsPrismaService, type WorkspaceClient } from '../infra/rls-prisma.service';
import { WorkspaceContext } from '../infra/workspace-context';

export interface ExclusionInput {
    address?: string | null | undefined;
    domain?: string | null | undefined;
    reason: ExclusionReason;
    accountManagerName?: string | null | undefined;
    source?: string | undefined;
    externalRef?: string | null | undefined;
    note?: string | null | undefined;
}

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

    async add(input: ExclusionInput): Promise<OutreachExclusionView> {
        const workspaceId = this.context.get()!.workspaceId;
        return view(await this.rls.withWorkspace((tx) => this.addIn(tx, workspaceId, input)));
    }

    async remove(id: string, note: string): Promise<void> {
        const removed = await this.rls.withWorkspace((tx) => this.removeIn(tx, id, note));
        if (!removed) throw new NotFoundException('exclusion not found');
    }

    /** #242: an admin looked at a flagged automatic exclusion and keeps it; the flag goes, the exclusion stays. */
    async dismissReview(id: string): Promise<OutreachExclusionView> {
        return this.rls.withWorkspace(async (tx) => {
            const changed = await tx.outreachExclusion.updateMany({
                where: { id, removedAt: null },
                data: { reviewReason: null, reviewFlaggedAt: null },
            });
            if (changed.count === 0) throw new NotFoundException('exclusion not found');
            return view((await tx.outreachExclusion.findUnique({ where: { id } }))!);
        });
    }

    // The writes inside a caller's transaction — the routes above and the Twenty importer (P4-4,
    // a lead lookup is an exclusion) both run these, so an exclusion is shaped one way.

    /** One live entry per address and per domain: a second is a `409` naming the field. */
    async addIn(tx: WorkspaceClient, workspaceId: string, input: ExclusionInput): Promise<OutreachExclusion> {
        const { address, domain } = exclusionTarget(input);
        try {
            return await tx.outreachExclusion.create({
                data: {
                    workspaceId,
                    address,
                    domain,
                    reason: input.reason,
                    accountManagerName: input.accountManagerName ?? null,
                    source: input.source ?? 'manual',
                    externalRef: input.externalRef ?? null,
                    note: input.note ?? null,
                },
            });
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

    /** Ends a live entry, keeping the row; `false` when there is no live entry with that id. */
    async removeIn(tx: WorkspaceClient, id: string, note: string): Promise<boolean> {
        const changed = await tx.outreachExclusion.updateMany({
            where: { id, removedAt: null },
            data: { removedAt: new Date(), removedNote: note },
        });
        return changed.count > 0;
    }

    /** The live exclusion for each address (by the address, else its domain), read in `tx`. */
    check(tx: WorkspaceClient, addresses: readonly string[]): Promise<Map<string, ExclusionHit>> {
        return exclusionHits(tx, addresses);
    }
}

/**
 * The live exclusion for each address (by the address, else its domain), read in `tx` — the one query the
 * enrolment screen, the step runner and the recipient guard (GUARD-1) all ask.
 */
export async function exclusionHits(
    tx: WorkspaceClient,
    addresses: readonly string[],
): Promise<Map<string, ExclusionHit>> {
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
        reviewReason: row.reviewReason as ExclusionReviewReason | null,
        reviewFlaggedAt: row.reviewFlaggedAt?.toISOString() ?? null,
    };
}

/**
 * Exactly one target, normalised by the one email rule (#180) — checked here, so the database's
 * `outreach_exclusions_one_target` constraint is a backstop, never the check a caller meets.
 */
export function exclusionTarget(input: Pick<ExclusionInput, 'address' | 'domain'>): {
    address: string | null;
    domain: string | null;
} {
    const address = input.address ? normaliseEmail(input.address) : null;
    const domain = input.domain?.trim().toLowerCase() || null;
    if (input.address && !address) {
        throw new ValidationFailed('not an email address', [{ path: 'address', message: 'not an email address' }]);
    }
    if (address && domain) {
        throw new ValidationFailed('an exclusion is an address or a domain, not both', [
            { path: 'domain', message: 'give an address or a domain, not both' },
        ]);
    }
    if (!address && !domain) {
        throw new ValidationFailed('an exclusion needs an address or a domain', [
            { path: 'address', message: 'an address or a domain is required' },
        ]);
    }
    return { address, domain };
}

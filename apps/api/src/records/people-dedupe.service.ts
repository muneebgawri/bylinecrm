import { Injectable } from '@nestjs/common';
import type { DomainEvent } from '@bylinecrm/shared';
import type { Prisma } from '@prisma/client';
import { DomainEvents } from '../events/domain-events.service';
import { PrismaService } from '../infra/prisma.service';
import { insideTransaction } from '../infra/transaction-scope';
import type { WorkspaceRunContext } from '../infra/workspace-context';
import { TransfersService } from '../transfers/transfers.service';
import {
    addCounts,
    chooseOwner,
    combined,
    EMPTY_PERSON_COUNTS,
    emailsOf,
    firstContacts,
    groupDuplicates,
    moveRelated,
    type DuplicateGroup,
    type DuplicateTier,
    type OwnerDecision,
    type PersonMergeCounts,
} from './merge-people';

const PERSON_FIELDS = {
    id: true,
    nameFirst: true,
    nameLast: true,
    emails: true,
    phones: true,
    links: true,
    jobTitle: true,
    source: true,
    country: true,
    city: true,
    avatarUrl: true,
    companyId: true,
    custom: true,
    ownerId: true,
    createdBy: true,
    createdAt: true,
} as const satisfies Prisma.PersonSelect;

/** One group in the report: who is kept, who is merged into them, who owns the result and why. */
export interface DedupeGroupResult {
    tier: DuplicateTier;
    why: string;
    survivorId: string;
    survivorName: string;
    mergedIds: string[];
    mergedNames: string[];
    emails: string[];
    biginIds: string[];
    ownerId: string | null;
    owner: string | null;
    ownerWhy: string;
    /** `merged`, `would merge`, `listed` (not merged this run), `skipped` (fewer than two left), or `failed: …`. */
    outcome: string;
    counts: PersonMergeCounts;
}

export interface DedupeReport {
    applied: boolean;
    groups: DedupeGroupResult[];
    tiers: Record<DuplicateTier, { groups: number; people: number }>;
    merged: number;
    failed: number;
    totals: PersonMergeCounts;
}

class DryRun extends Error {
    constructor(readonly result: { decision: OwnerDecision; counts: PersonMergeCounts }) {
        super('dry run');
    }
}

/**
 * Merges people saved more than once (the 2026-10-12 Twenty import's duplicates), one workspace at a time. Each
 * group is one transaction on the owner connection (the app role may not move timeline entries), every query
 * scoped to the workspace: the survivor takes the duplicates' addresses, phones and blanks and everything that
 * points at them (`moveRelated`); each duplicate is trashed with `merged_into_id`; the survivor goes to the member
 * who first contacted or saved the lead (`chooseOwner`) as a forced transfer — audited, the member told, the same
 * `transfer.completed` any hand-over announces; `person.merged` is recorded on both sides (timeline + webhooks).
 * Re-running finds only what is left: merged people are in the trash, so it is idempotent and resumable.
 */
@Injectable()
export class PeopleDedupe {
    constructor(
        private readonly ownerPrisma: PrismaService,
        private readonly transfers: TransfersService,
        private readonly events: DomainEvents,
    ) {}

    /** The workspace's duplicate groups, both tiers. */
    async detect(workspaceId: string): Promise<DuplicateGroup[]> {
        const people = await this.ownerPrisma.person.findMany({
            where: { workspaceId, deletedAt: null },
            select: { id: true, nameFirst: true, nameLast: true, emails: true, companyId: true, createdAt: true },
        });
        return groupDuplicates(people);
    }

    /**
     * Detects and merges: the `auto` tier, and the `review` tier too with `includeReview` (after the auto tier,
     * so a review group is merged whole). Without `apply` each merge is made and rolled back — the counts are
     * exact. `limit` caps the merges of one run (run again to go on).
     */
    async run(
        workspaceId: string,
        options: {
            apply: boolean;
            includeReview?: boolean;
            limit?: number | undefined;
            onGroup?: (g: DedupeGroupResult) => void;
        },
    ): Promise<DedupeReport> {
        const groups = await this.detect(workspaceId);
        const report: DedupeReport = {
            applied: options.apply,
            groups: [],
            tiers: { auto: { groups: 0, people: 0 }, review: { groups: 0, people: 0 } },
            merged: 0,
            failed: 0,
            totals: { ...EMPTY_PERSON_COUNTS },
        };
        for (const g of groups) {
            report.tiers[g.tier].groups += 1;
            report.tiers[g.tier].people += g.personIds.length;
        }
        const ordered = [...groups.filter((g) => g.tier === 'auto'), ...groups.filter((g) => g.tier === 'review')];
        let merges = 0;
        for (const group of ordered) {
            const mergeIt =
                (group.tier === 'auto' || options.includeReview === true) &&
                (options.limit === undefined || merges < options.limit);
            const result = await this.group(workspaceId, group, mergeIt ? options.apply : null);
            if (mergeIt && (result.outcome === 'merged' || result.outcome === 'would merge')) {
                merges += 1;
                report.merged += 1;
                addCounts(report.totals, result.counts);
            }
            if (result.outcome.startsWith('failed')) report.failed += 1;
            report.groups.push(result);
            options.onGroup?.(result);
        }
        return report;
    }

    /**
     * One group: `apply` true merges it, false merges and rolls back, null only plans it (who is kept and who owns).
     */
    async group(workspaceId: string, group: DuplicateGroup, apply: boolean | null): Promise<DedupeGroupResult> {
        const people = await this.ownerPrisma.person.findMany({
            where: { workspaceId, id: { in: group.personIds } },
            select: { ...PERSON_FIELDS, deletedAt: true },
        });
        const name = (id: string) => {
            const p = people.find((x) => x.id === id);
            return p ? `${p.nameFirst} ${p.nameLast}`.trim() : id;
        };
        const links = await this.ownerPrisma.biginImportLink.findMany({
            where: { workspaceId, localType: 'person', localId: { in: group.personIds } },
            select: { externalId: true },
        });
        let decision: OwnerDecision;
        let counts = { ...EMPTY_PERSON_COUNTS };
        let outcome: string;
        try {
            if (apply === null) {
                decision = await this.ownerPrisma.$transaction((tx) => this.decide(tx, workspaceId, group.personIds));
                outcome = 'listed';
            } else {
                const done = await this.merge(workspaceId, group.personIds, apply);
                if (done === null) {
                    decision = { ownerId: null, survivorId: group.personIds[0]!, why: 'already merged' };
                    outcome = 'skipped';
                } else {
                    ({ decision, counts } = done);
                    outcome = apply ? 'merged' : 'would merge';
                }
            }
        } catch (error) {
            decision = { ownerId: null, survivorId: group.personIds[0]!, why: '' };
            outcome = `failed: ${error instanceof Error ? error.message : String(error)}`;
        }
        const owner = decision.ownerId ? await this.memberLabel(workspaceId, decision.ownerId) : null;
        return {
            tier: group.tier,
            why: group.why,
            survivorId: decision.survivorId,
            survivorName: name(decision.survivorId),
            mergedIds: group.personIds.filter((id) => id !== decision.survivorId),
            mergedNames: group.personIds.filter((id) => id !== decision.survivorId).map(name),
            emails: [...new Set(people.flatMap((p) => emailsOf(p.emails)))],
            biginIds: links.map((l) => l.externalId),
            ownerId: decision.ownerId,
            owner,
            ownerWhy: decision.why,
            outcome,
            counts,
        };
    }

    /**
     * Merges the live people of `personIds` into one, in one transaction; `apply` false rolls it back. Null when
     * fewer than two are still live (merged already).
     */
    async merge(
        workspaceId: string,
        personIds: readonly string[],
        apply: boolean,
    ): Promise<{ decision: OwnerDecision; counts: PersonMergeCounts } | null> {
        const hooks: (() => void)[] = [];
        try {
            const result = await this.ownerPrisma.$transaction(
                (tx) =>
                    insideTransaction(hooks, async () => {
                        const r = await this.mergeIn(tx, workspaceId, personIds);
                        if (!apply && r) throw new DryRun(r);
                        return r;
                    }),
                { maxWait: 10_000, timeout: 120_000 },
            );
            for (const hook of hooks) hook();
            return result;
        } catch (error) {
            if (error instanceof DryRun) return error.result;
            throw error;
        }
    }

    private async decide(tx: Prisma.TransactionClient, workspaceId: string, personIds: readonly string[]) {
        const people = await tx.person.findMany({
            where: { workspaceId, id: { in: [...personIds] }, deletedAt: null },
            select: { id: true, createdAt: true, ownerId: true, createdBy: true },
        });
        const contacts = await firstContacts(
            tx,
            workspaceId,
            people.map((p) => p.id),
        );
        const members = await tx.workspaceMember.findMany({
            where: { workspaceId, leftAt: null },
            select: { id: true },
        });
        return chooseOwner(people, contacts, new Set(members.map((m) => m.id)));
    }

    private async mergeIn(
        tx: Prisma.TransactionClient,
        workspaceId: string,
        personIds: readonly string[],
    ): Promise<{ decision: OwnerDecision; counts: PersonMergeCounts } | null> {
        // Lock the group: a concurrent run (or an edit) waits; whoever comes second finds them merged.
        const live = await tx.$queryRaw<{ id: string }[]>`
            SELECT id::text FROM people WHERE workspace_id = ${workspaceId}::uuid AND id::text = ANY(${[...personIds]})
               AND deleted_at IS NULL ORDER BY created_at, id FOR UPDATE`;
        if (live.length < 2) return null;
        const decision = await this.decide(
            tx,
            workspaceId,
            live.map((p) => p.id),
        );
        const survivorId = decision.survivorId;
        let survivor = await tx.person.findUniqueOrThrow({ where: { id: survivorId }, select: PERSON_FIELDS });
        const before = survivor;
        const counts = { ...EMPTY_PERSON_COUNTS };
        const mergedIds: string[] = [];
        const now = new Date();
        for (const { id } of live) {
            if (id === survivorId) continue;
            const dup = await tx.person.findUniqueOrThrow({ where: { id }, select: PERSON_FIELDS });
            // The duplicate gives up its primary address first: the primary is unique per workspace, trash included.
            await tx.person.update({
                where: { id },
                data: { emails: { primary: null, additional: emailsOf(dup.emails) } },
            });
            const next = combined(survivor, dup);
            survivor = await tx.person.update({
                where: { id: survivorId },
                data: { ...next, custom: next.custom as Prisma.InputJsonObject },
                select: PERSON_FIELDS,
            });
            addCounts(counts, await moveRelated(tx, workspaceId, id, survivorId));
            await tx.person.update({ where: { id }, data: { deletedAt: now, mergedIntoId: survivorId } });
            mergedIds.push(id);
        }

        const context: WorkspaceRunContext = {
            workspaceId,
            capabilities: new Set(),
            actor: { kind: 'system', id: null },
        };
        const to = decision.ownerId;
        const from = before.ownerId;
        if (to && from !== to) {
            await tx.person.update({ where: { id: survivorId }, data: { ownerId: to } });
            await this.transfers.recordHandOverIn(tx, context, {
                from: from ?? to,
                to,
                target: { type: 'person', id: survivorId },
                reason: `Duplicates merged — ${decision.why}`,
            });
        }

        const occurredAt = now.toISOString();
        const diff: Record<string, { from: unknown; to: unknown }> = { mergedFrom: { from: null, to: mergedIds } };
        for (const key of ['emails', 'phones', 'links', 'jobTitle', 'companyId', 'nameFirst', 'nameLast'] as const) {
            if (JSON.stringify(before[key]) !== JSON.stringify(survivor[key])) {
                diff[key] = { from: before[key], to: survivor[key] };
            }
        }
        if (to && from !== to) diff.ownerId = { from, to };
        const base = {
            type: 'person.merged',
            object: 'person',
            workspaceId,
            actor: context.actor!,
            occurredAt,
        } as const;
        const events: DomainEvent[] = [
            { ...base, recordId: survivorId, diff },
            ...mergedIds.map((id) => ({
                ...base,
                recordId: id,
                diff: { mergedInto: { from: null, to: survivorId }, deletedAt: { from: null, to: occurredAt } },
            })),
        ];
        await this.events.recordAll(tx, events);
        return { decision: { ...decision, ownerId: to ?? from }, counts };
    }

    private async memberLabel(workspaceId: string, memberId: string): Promise<string> {
        const m = await this.ownerPrisma.workspaceMember.findFirst({
            where: { workspaceId, id: memberId },
            select: { user: { select: { displayName: true, email: true } } },
        });
        return m ? (m.user.displayName ?? m.user.email) : memberId;
    }
}

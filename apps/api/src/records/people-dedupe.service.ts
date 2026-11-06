import { Injectable } from '@nestjs/common';
import type { DomainEvent, Emails } from '@bylinecrm/shared';
import type { Prisma } from '@prisma/client';
import { DomainEvents } from '../events/domain-events.service';
import { PrismaService } from '../infra/prisma.service';
import { insideTransaction } from '../infra/transaction-scope';
import type { WorkspaceRunContext } from '../infra/workspace-context';
import { TransfersService } from '../transfers/transfers.service';
import { companyDomainOfAddress, normalisedDomain } from './company-ownership';
import {
    addCounts,
    addressKeepers,
    chooseOwner,
    combined,
    EMPTY_PERSON_COUNTS,
    emailsOf,
    firstContacts,
    groupDuplicates,
    KEEPER_WHY,
    moveRelated,
    normaliseEmail,
    type DuplicateGroup,
    DUPLICATE_TIERS,
    type DuplicateTier,
    type OwnerDecision,
    type PersonMergeCounts,
    withoutAddress,
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

/** One address shared by people of a name-mismatch group: who keeps it, who gives it up — or why nobody does. */
export interface AddressResult {
    email: string;
    /** `released`, `would release`, `unresolved` (a person decides), or `failed: …`. */
    outcome: string;
    keeperId: string | null;
    keeperName: string | null;
    fromIds: string[];
    fromNames: string[];
    why: string;
}

export interface AddressReport {
    applied: boolean;
    addresses: AddressResult[];
    released: number;
    unresolved: number;
    failed: number;
}

export interface DedupeReport {
    applied: boolean;
    groups: DedupeGroupResult[];
    tiers: Record<DuplicateTier, { groups: number; people: number }>;
    merged: number;
    failed: number;
    totals: PersonMergeCounts;
}

class RolledBack extends Error {
    constructor() {
        super('dry run');
    }
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
        // A Bigin Contact's address as Bigin has it now is its person's too, though the import kept an older one:
        // where another person already has it, the two are one person saved twice.
        const links = await this.ownerPrisma.biginImportLink.findMany({
            where: { workspaceId, object: 'Contacts', localType: 'person' },
            select: { localId: true, snapshot: true },
        });
        const biginAddresses = new Map<string, string[]>();
        for (const link of links) {
            const email = (link.snapshot as { email?: unknown } | null)?.email;
            if (typeof email === 'string') {
                biginAddresses.set(link.localId, [...(biginAddresses.get(link.localId) ?? []), email]);
            }
        }
        return groupDuplicates(
            people.map((p) => {
                const more = biginAddresses.get(p.id);
                if (!more) return p;
                const emails = (p.emails ?? {}) as { primary?: unknown; additional?: unknown };
                const additional: unknown[] = Array.isArray(emails.additional) ? emails.additional : [];
                return { ...p, emails: { ...emails, additional: [...additional, ...more] } };
            }),
        );
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
            tiers: {
                auto: { groups: 0, people: 0 },
                auto_name_mismatch: { groups: 0, people: 0 },
                review: { groups: 0, people: 0 },
            },
            merged: 0,
            failed: 0,
            totals: { ...EMPTY_PERSON_COUNTS },
        };
        for (const g of groups) {
            report.tiers[g.tier].groups += 1;
            report.tiers[g.tier].people += g.personIds.length;
        }
        // A name-mismatch group is listed, never merged — not even with `includeReview`.
        const ordered = DUPLICATE_TIERS.flatMap((tier) => groups.filter((g) => g.tier === tier));
        let merges = 0;
        for (const group of ordered) {
            const mergeIt =
                (group.tier === 'auto' || (group.tier === 'review' && options.includeReview === true)) &&
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
        // People merged into one of these before merging gave up addresses still hold copies of them (trashed, and
        // counted by `people_address_taken`): what they held is the person they were merged into's already.
        await tx.person.updateMany({
            where: { workspaceId, mergedIntoId: { in: live.map((p) => p.id) }, deletedAt: { not: null } },
            data: { emails: { primary: null, additional: [] } },
        });
        for (const { id } of live) {
            if (id === survivorId) continue;
            const dup = await tx.person.findUniqueOrThrow({ where: { id }, select: PERSON_FIELDS });
            // The duplicate gives up every address first: an address is one person's, primary or additional, trash
            // included (`people_address_taken`), so the survivor can only take them once the duplicate holds none.
            await tx.person.update({ where: { id }, data: { emails: { primary: null, additional: [] } } });
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

    /**
     * People who share an address but are not one person (the `auto_name_mismatch` groups, never merged): each
     * shared address goes to one holder (`addressKeepers`: the one it names, else the one at the company whose
     * domain it is, else the one whose primary it is) and the others give it up, recorded as their `person.updated`
     * (`emails`, by the system) — timeline, webhooks, and mail and calendar re-link as for any edit. One transaction
     * per group, the people locked and read again; without `apply` each is rolled back. Unresolved and listed: an
     * address no rule settles, one whose giving up would leave a person with neither a name nor an address, and
     * one with mail linked to a person who would give it up, unless the address names the keeper. Re-running
     * finds only what is left.
     */
    async releaseAddresses(
        workspaceId: string,
        options: { apply: boolean; onGroup?: () => void },
    ): Promise<AddressReport> {
        const groups = (await this.detect(workspaceId)).filter((g) => g.tier === 'auto_name_mismatch');
        const report: AddressReport = { applied: options.apply, addresses: [], released: 0, unresolved: 0, failed: 0 };
        for (const group of groups) {
            let results: AddressResult[];
            try {
                results = await this.releaseGroup(workspaceId, group.personIds, options.apply);
            } catch (error) {
                const message = `failed: ${error instanceof Error ? error.message : String(error)}`;
                results = [
                    {
                        email: group.why,
                        outcome: message,
                        keeperId: null,
                        keeperName: null,
                        fromIds: group.personIds,
                        fromNames: [],
                        why: group.personIds.join(' '),
                    },
                ];
            }
            for (const r of results) {
                if (r.outcome === 'released' || r.outcome === 'would release') report.released += 1;
                else if (r.outcome === 'unresolved') report.unresolved += 1;
                else report.failed += 1;
                report.addresses.push(r);
            }
            options.onGroup?.();
        }
        return report;
    }

    private async releaseGroup(
        workspaceId: string,
        personIds: readonly string[],
        apply: boolean,
    ): Promise<AddressResult[]> {
        const hooks: (() => void)[] = [];
        let results: AddressResult[] = [];
        try {
            await this.ownerPrisma.$transaction(
                (tx) =>
                    insideTransaction(hooks, async () => {
                        results = await this.releaseIn(tx, workspaceId, personIds, apply);
                        if (!apply) throw new RolledBack();
                    }),
                { maxWait: 10_000, timeout: 120_000 },
            );
            for (const hook of hooks) hook();
        } catch (error) {
            if (!(error instanceof RolledBack)) throw error;
        }
        return results;
    }

    private async releaseIn(
        tx: Prisma.TransactionClient,
        workspaceId: string,
        personIds: readonly string[],
        apply: boolean,
    ): Promise<AddressResult[]> {
        await tx.$queryRaw`
            SELECT id FROM people WHERE workspace_id = ${workspaceId}::uuid AND id::text = ANY(${[...personIds]})
               AND deleted_at IS NULL ORDER BY created_at, id FOR UPDATE`;
        const people = await tx.person.findMany({
            where: { workspaceId, id: { in: [...personIds] }, deletedAt: null },
            select: { id: true, nameFirst: true, nameLast: true, emails: true, companyId: true },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        });
        const byId = new Map(people.map((p) => [p.id, p]));
        const name = (id: string) => {
            const p = byId.get(id)!;
            return `${p.nameFirst} ${p.nameLast}`.trim();
        };
        const addresses = [...new Set(people.flatMap((p) => emailsOf(p.emails)))];
        const { releases, unresolved } = addressKeepers(
            people,
            await this.companiesOfAddresses(tx, workspaceId, addresses),
        );
        // Mail already linked to a person by an address (stored lower case): only the name rule may take that
        // address from them.
        const mailed = await tx.$queryRaw<{ person_id: string; address: string }[]>`
            SELECT DISTINCT person_id::text, address FROM mail_participants
             WHERE workspace_id = ${workspaceId}::uuid AND person_id::text = ANY(${[...personIds]})
               AND address = ANY(${addresses})`;
        const hasMail = new Set(mailed.map((m) => `${m.person_id} ${m.address}`));
        const results: AddressResult[] = unresolved.map((u) => ({
            email: u.email,
            outcome: 'unresolved',
            keeperId: null,
            keeperName: null,
            fromIds: u.holderIds,
            fromNames: u.holderIds.map(name),
            why: u.why,
        }));
        const emails = new Map(people.map((p) => [p.id, p.emails as unknown]));
        // Primaries outside the group, trash included: an address promoted to primary must be nobody else's.
        const outside = await tx.person.findMany({
            where: {
                workspaceId,
                id: { notIn: [...personIds] },
                emailPrimary: { in: addresses },
            },
            select: { emailPrimary: true },
        });
        const primariesOutside = outside.map((p) => p.emailPrimary!);
        const changed = new Set<string>();
        for (const r of releases) {
            // One at a time, so two people giving up an address never promote the same one.
            const next = new Map<string, Emails>();
            for (const id of r.fromIds) {
                const taken = new Set(primariesOutside);
                for (const [other, e] of [...emails, ...next]) {
                    const primary = normaliseEmail((e as Partial<Emails> | null)?.primary);
                    if (other !== id && primary) taken.add(primary);
                }
                next.set(id, withoutAddress(emails.get(id), r.email, taken));
            }
            const stranded = r.fromIds.find((id) => !name(id) && next.get(id)!.primary === null);
            const mailedTo = r.by === 'name' ? undefined : r.fromIds.find((id) => hasMail.has(`${id} ${r.email}`));
            if (stranded || mailedTo) {
                results.push({
                    email: r.email,
                    outcome: 'unresolved',
                    keeperId: r.keeperId,
                    keeperName: name(r.keeperId),
                    fromIds: r.fromIds,
                    fromNames: r.fromIds.map(name),
                    why: stranded
                        ? `${stranded} would have neither a name nor an address`
                        : `${name(mailedTo!) || mailedTo} has mail on it`,
                });
                continue;
            }
            for (const [id, e] of next) {
                emails.set(id, e);
                changed.add(id);
            }
            results.push({
                email: r.email,
                outcome: apply ? 'released' : 'would release',
                keeperId: r.keeperId,
                keeperName: name(r.keeperId),
                fromIds: r.fromIds,
                fromNames: r.fromIds.map(name),
                why: KEEPER_WHY[r.by],
            });
        }
        const actor = { kind: 'system', id: null } as const;
        const occurredAt = new Date().toISOString();
        const events: DomainEvent[] = [];
        for (const id of changed) {
            const before = byId.get(id)!.emails;
            const after = emails.get(id) as Emails;
            await tx.person.update({ where: { id }, data: { emails: after } });
            events.push({
                type: 'person.updated',
                object: 'person',
                workspaceId,
                actor,
                occurredAt,
                recordId: id,
                diff: { emails: { from: before, to: after } },
            });
        }
        if (events.length > 0) await this.events.recordAll(tx, events);
        return results.sort((a, b) => a.email.localeCompare(b.email));
    }

    /**
     * The live company whose domain each address is at (`companyDomainOfAddress`; free mail is at none), as
     * `CompanyOwnership.companyForDomain` reads it: the company's own domain first — the earliest saved — then one
     * of its other domains.
     */
    private async companiesOfAddresses(
        tx: Prisma.TransactionClient,
        workspaceId: string,
        addresses: readonly string[],
    ): Promise<Map<string, string | null>> {
        const keyOf = new Map(
            addresses.map((a) => {
                const d = companyDomainOfAddress(a);
                return [a, d ? normalisedDomain(d) : null] as const;
            }),
        );
        const keys = [...new Set([...keyOf.values()].filter((k): k is string => k !== null))];
        const forms = keys.flatMap((k) => [k, `www.${k}`]);
        const company = new Map<string, string>();
        if (keys.length > 0) {
            const own = await tx.company.findMany({
                where: { workspaceId, deletedAt: null, domain: { in: forms } },
                select: { id: true, domain: true },
                orderBy: { createdAt: 'asc' },
            });
            for (const c of own) {
                const k = normalisedDomain(c.domain!);
                if (!company.has(k)) company.set(k, c.id);
            }
            const other = await tx.companyDomain.findMany({
                where: { domain: { in: forms }, company: { workspaceId, deletedAt: null } },
                select: { domain: true, companyId: true },
            });
            for (const c of other) {
                const k = normalisedDomain(c.domain);
                if (!company.has(k)) company.set(k, c.companyId);
            }
        }
        return new Map(addresses.map((a) => [a, company.get(keyOf.get(a) ?? '') ?? null]));
    }

    private async memberLabel(workspaceId: string, memberId: string): Promise<string> {
        const m = await this.ownerPrisma.workspaceMember.findFirst({
            where: { workspaceId, id: memberId },
            select: { user: { select: { displayName: true, email: true } } },
        });
        return m ? (m.user.displayName ?? m.user.email) : memberId;
    }
}

import type { Prisma, PrismaClient } from '@prisma/client';
import { companyDomain } from './company-domain';

/** One duplicate and the company it is merged into. */
export interface MergePair {
    workspaceId: string;
    duplicateId: string;
    duplicateDomain: string;
    keptId: string;
    keptDomain: string;
}

/** What one merge moved, per kind of thing; every kind is reported, zero included. */
export interface MergeCounts {
    people: number;
    deals: number;
    otherDomains: number;
    noteLinks: number;
    taskLinks: number;
    files: number;
    timelineEntries: number;
    enrichmentAnswers: number;
    transferHistory: number;
    openOffersCancelled: number;
    twentyLinks: number;
}

export const EMPTY_COUNTS: MergeCounts = {
    people: 0,
    deals: 0,
    otherDomains: 0,
    noteLinks: 0,
    taskLinks: 0,
    files: 0,
    timelineEntries: 0,
    enrichmentAnswers: 0,
    transferHistory: 0,
    openOffersCancelled: 0,
    twentyLinks: 0,
};

/**
 * The companies saved twice (OWN-2e, #201): live companies whose domains share one registrable domain, in one
 * workspace. In each group the company already on the registrable domain is kept (else the oldest); every other
 * is a duplicate to merge into it. The same grouping the Ownership page lists as "Same company saved twice".
 */
export async function duplicatePairs(db: PrismaClient, workspaceId?: string): Promise<MergePair[]> {
    const companies = await db.company.findMany({
        where: { deletedAt: null, domain: { not: null }, ...(workspaceId ? { workspaceId } : {}) },
        select: { id: true, workspaceId: true, domain: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const groups = new Map<string, typeof companies>();
    for (const c of companies) {
        const key = companyDomain(c.domain);
        if (!key) continue;
        const group = `${c.workspaceId} ${key}`;
        groups.set(group, [...(groups.get(group) ?? []), c]);
    }
    const pairs: MergePair[] = [];
    for (const [group, members] of groups) {
        if (members.length < 2) continue;
        const key = group.slice(group.indexOf(' ') + 1);
        const kept = members.find((c) => c.domain === key) ?? members[0]!;
        for (const dup of members) {
            if (dup.id === kept.id) continue;
            pairs.push({
                workspaceId: dup.workspaceId,
                duplicateId: dup.id,
                duplicateDomain: dup.domain!,
                keptId: kept.id,
                keptDomain: kept.domain!,
            });
        }
    }
    return pairs;
}

/**
 * Merges one duplicate into its kept company, in the transaction given (the owner connection: the app role may
 * not move timeline entries). Everything that points at the duplicate points at the kept company — people, deals,
 * other domains, note, task and file links, timeline entries, enrichment answers, transfer history (an open offer
 * of the duplicate is cancelled) and the Twenty importer's links, so the next sync updates the kept company. The
 * kept company takes what it lacks (owner, logo, size, ARR, custom values; ICP if either is); what it has stays.
 * The duplicate goes to the trash, where it can be restored. A link that would repeat one the kept company
 * already has (a note on both) is kept once.
 */
export async function mergeCompany(tx: Prisma.TransactionClient, pair: MergePair): Promise<MergeCounts> {
    const { duplicateId: dup, keptId: kept } = pair;
    const n = (rows: number | bigint) => Number(rows);
    const counts: MergeCounts = { ...EMPTY_COUNTS };

    counts.people = n(
        await tx.$executeRaw`UPDATE people SET company_id = ${kept}::uuid, updated_at = now() WHERE company_id = ${dup}::uuid`,
    );
    counts.deals = n(
        await tx.$executeRaw`UPDATE opportunities SET company_id = ${kept}::uuid, updated_at = now() WHERE company_id = ${dup}::uuid`,
    );
    counts.otherDomains = n(
        await tx.$executeRaw`UPDATE company_domains SET company_id = ${kept}::uuid WHERE company_id = ${dup}::uuid`,
    );

    await tx.$executeRaw`DELETE FROM note_targets t WHERE t.target_type = 'company' AND t.target_id = ${dup}::uuid
        AND EXISTS (SELECT 1 FROM note_targets k WHERE k.note_id = t.note_id AND k.target_type = 'company' AND k.target_id = ${kept}::uuid)`;
    counts.noteLinks = n(
        await tx.$executeRaw`UPDATE note_targets SET target_id = ${kept}::uuid WHERE target_type = 'company' AND target_id = ${dup}::uuid`,
    );
    await tx.$executeRaw`DELETE FROM task_targets t WHERE t.target_type = 'company' AND t.target_id = ${dup}::uuid
        AND EXISTS (SELECT 1 FROM task_targets k WHERE k.task_id = t.task_id AND k.target_type = 'company' AND k.target_id = ${kept}::uuid)`;
    counts.taskLinks = n(
        await tx.$executeRaw`UPDATE task_targets SET target_id = ${kept}::uuid WHERE target_type = 'company' AND target_id = ${dup}::uuid`,
    );
    counts.files = n(
        await tx.$executeRaw`UPDATE attachments SET target_id = ${kept}::uuid WHERE target_type = 'company' AND target_id = ${dup}::uuid`,
    );

    await tx.$executeRaw`DELETE FROM timeline_activities t WHERE t.target_type = 'company' AND t.target_id = ${dup}::uuid
        AND EXISTS (SELECT 1 FROM timeline_activities k WHERE k.workspace_id = t.workspace_id AND k.event_id = t.event_id
                    AND k.target_type = 'company' AND k.target_id = ${kept}::uuid)`;
    counts.timelineEntries = n(
        await tx.$executeRaw`UPDATE timeline_activities SET target_id = ${kept}::uuid WHERE target_type = 'company' AND target_id = ${dup}::uuid`,
    );
    counts.enrichmentAnswers = n(
        await tx.$executeRaw`UPDATE enrichment_answers SET record_id = ${kept}::uuid WHERE object = 'company' AND record_id = ${dup}::uuid`,
    );
    counts.openOffersCancelled = n(
        await tx.$executeRaw`UPDATE ownership_transfers SET status = 'cancelled', note = 'The company was merged into another.', decided_at = now(), updated_at = now()
        WHERE object = 'company' AND record_id = ${dup}::uuid AND status = 'proposed'`,
    );
    counts.transferHistory = n(
        await tx.$executeRaw`UPDATE ownership_transfers SET record_id = ${kept}::uuid, updated_at = now() WHERE object = 'company' AND record_id = ${dup}::uuid`,
    );
    counts.twentyLinks = n(
        await tx.$executeRaw`UPDATE twenty_import_links SET local_id = ${kept}::uuid WHERE local_type = 'company' AND local_id = ${dup}::uuid`,
    );

    await tx.$executeRaw`UPDATE companies k SET
            owner_id = COALESCE(k.owner_id, d.owner_id),
            logo_url = COALESCE(k.logo_url, d.logo_url),
            employee_count = COALESCE(k.employee_count, d.employee_count),
            arr_minor = CASE WHEN k.arr_minor IS NULL THEN d.arr_minor ELSE k.arr_minor END,
            arr_currency = CASE WHEN k.arr_minor IS NULL THEN d.arr_currency ELSE k.arr_currency END,
            icp = k.icp OR d.icp,
            custom = d.custom || k.custom,
            updated_at = now()
        FROM companies d WHERE k.id = ${kept}::uuid AND d.id = ${dup}::uuid`;
    await tx.$executeRaw`UPDATE companies SET deleted_at = now(), updated_at = now() WHERE id = ${dup}::uuid AND deleted_at IS NULL`;
    return counts;
}

import 'reflect-metadata';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { DomainEvents } from '../events/domain-events.service';
import { PrismaService } from '../infra/prisma.service';
import { RlsPrismaService } from '../infra/rls-prisma.service';
import { WorkspaceContext, type WorkspaceRunContext } from '../infra/workspace-context';
import { CompaniesService } from '../records/companies.service';
import { companyDomainOfAddress } from '../records/company-ownership';
import { PeopleService } from '../records/people.service';
import { assignCompanyOwners } from './assign-company-owners';

const USAGE = 'usage: node dist/cli/link-people-to-companies.js <workspace-slug> --estimate|--apply';

/** People read per statement: a page, never the whole table. */
export const READ_PAGE = 5000;

/**
 * People linked per transaction — `assign-company-owners`' lesson (`WRITE_CHUNK` there): a transaction is short,
 * a chunk that fails leaves the ones before it committed, and a rerun continues from the people still without a
 * company.
 */
export const WRITE_CHUNK = 20;

export interface LinkOptions {
    /** Write: without it, nothing changes and the counts say what `--apply` would do. */
    apply: boolean;
    onProgress?: (line: string) => void;
}

export interface LinkReport {
    /** Live people with no company whose primary address is at a company domain (not free mail). */
    people: number;
    /** The domains those addresses are at. */
    domains: number;
    /** People linked to the company that already has their domain. */
    joined: number;
    /** Companies made for a domain no company had, named for the domain. */
    created: number;
    /** People linked to those new companies. */
    joinedNew: number;
    /** Of the new companies, those whose people have more than one owner: the first saver's, as any company is. */
    createdShared: number;
    /** People left as they were: their chunk was refused (the reason is on stderr, no record named). */
    failed: number;
    /** Companies with no owner given their first saver's (`assign-company-owners`, run after the links). */
    ownersFilled: number;
}

interface Candidate {
    id: string;
    ownerId: string | null;
}

interface Work {
    domain: string;
    /** The company that has the domain; null for one to make. */
    companyId: string | null;
    people: Candidate[];
}

/**
 * A job acting for the workspace, as an import: no caller, so the ownership rule's checks do not bind it, and what
 * it writes is not the owner working the company (OWN-2f reads an import's writes as nobody's work).
 */
function jobContext(workspaceId: string): WorkspaceRunContext {
    return { workspaceId, capabilities: new Set(), actor: { kind: 'import', id: null } };
}

/**
 * OWN-2 reads a person with no company as at the company their address's domain names (`companyForDomain`): the
 * guard, the save check and the "already theirs" answer all do. The record itself said nothing, so a rep saw a lead
 * with no company refused for a company they had never heard of. This links every live person who has no company and
 * a company address to the company at that domain — the one that already has it (as its own or other domain, as
 * `companyForDomain` reads it), else a new one named for the domain, as "Add lead" makes one — through the record
 * services, `WRITE_CHUNK` people per transaction, each change on the record's history and kept in BylineCRM
 * (`internal`: no webhook mirrors a backfill). The new companies then take their first saver as owner through
 * `assignCompanyOwners`, the one way an empty owner is filled. Free mail and consumer providers name no company and
 * are left alone. Re-running changes nothing once done. Counts only: no record is named.
 */
export async function linkPeopleToCompanies(
    app: INestApplicationContext,
    workspaceId: string,
    options: LinkOptions,
): Promise<LinkReport> {
    const owner = app.get(PrismaService);
    const rls = app.get(RlsPrismaService);
    const people = app.get(PeopleService);
    const companies = app.get(CompaniesService);
    const events = app.get(DomainEvents);
    const scope = app.get(WorkspaceContext);
    const context = jobContext(workspaceId);
    const progress = options.onProgress ?? (() => undefined);
    const report: LinkReport = {
        people: 0,
        domains: 0,
        joined: 0,
        created: 0,
        joinedNew: 0,
        createdShared: 0,
        failed: 0,
        ownersFilled: 0,
    };

    // 1. The people, by the company domain of their address (its registrable domain: the code's reading, not SQL's).
    const byDomain = new Map<string, Candidate[]>();
    let after = '00000000-0000-0000-0000-000000000000';
    for (;;) {
        const page = await owner.$queryRaw<{ id: string; email: string; owner_id: string | null }[]>`
            SELECT p.id::text AS id, p.email_primary AS email, p.owner_id::text AS owner_id
            FROM people p
            WHERE p.workspace_id = ${workspaceId}::uuid AND p.deleted_at IS NULL AND p.company_id IS NULL
              AND p.email_primary IS NOT NULL AND p.id > ${after}::uuid
            ORDER BY p.id LIMIT ${READ_PAGE}`;
        if (page.length === 0) break;
        for (const p of page) {
            const domain = companyDomainOfAddress(p.email);
            if (!domain) continue;
            const list = byDomain.get(domain) ?? [];
            list.push({ id: p.id, ownerId: p.owner_id });
            byDomain.set(domain, list);
            report.people += 1;
        }
        after = page[page.length - 1]!.id;
    }
    report.domains = byDomain.size;
    progress(`… ${report.people} people with no company at ${report.domains} company domains`);

    // 2. The company each domain already has, read as `companyForDomain` reads it: a company's own domain first (the
    //    earliest saved), then another company's other domain; bare or with `www.`.
    const own = new Map<string, string>();
    const other = new Map<string, string>();
    const bare = (domain: string) =>
        domain
            .trim()
            .toLowerCase()
            .replace(/^www\./, '');
    const ownRows = await owner.$queryRaw<{ id: string; domain: string }[]>`
        SELECT c.id::text AS id, c.domain FROM companies c
        WHERE c.workspace_id = ${workspaceId}::uuid AND c.deleted_at IS NULL AND c.domain IS NOT NULL
        ORDER BY c.created_at, c.id`;
    for (const c of ownRows) if (!own.has(bare(c.domain))) own.set(bare(c.domain), c.id);
    const otherRows = await owner.$queryRaw<{ id: string; domain: string }[]>`
        SELECT c.id::text AS id, d.domain FROM company_domains d
        JOIN companies c ON c.id = d.company_id AND c.deleted_at IS NULL
        WHERE d.workspace_id = ${workspaceId}::uuid
        ORDER BY d.created_at, d.id`;
    for (const c of otherRows) if (!other.has(bare(c.domain))) other.set(bare(c.domain), c.id);

    const work: Work[] = [...byDomain.keys()].sort().map((domain) => ({
        domain,
        companyId: own.get(domain) ?? other.get(domain) ?? null,
        people: byDomain.get(domain)!,
    }));

    if (!options.apply) {
        for (const w of work) {
            if (w.companyId) {
                report.joined += w.people.length;
                continue;
            }
            report.created += 1;
            report.joinedNew += w.people.length;
            if (new Set(w.people.map((p) => p.ownerId).filter(Boolean)).size > 1) report.createdShared += 1;
        }
        const fill = await assignCompanyOwners(app, workspaceId, { apply: false, reassignPeople: false });
        // The companies there are, plus the new ones any of whose people has an owner.
        report.ownersFilled =
            fill.assigned + work.filter((w) => !w.companyId && w.people.some((p) => p.ownerId !== null)).length;
        return report;
    }

    // 3. The links, a chunk per transaction. A domain's company is made with its first people; a domain with more
    //    people than a chunk holds carries on in the next with the company it was given.
    // In the job's workspace scope: the record services read it (custom fields, the owner scope) as on a request.
    const write = (items: readonly Work[]) =>
        scope.run(context, () =>
            rls.withWorkspace(workspaceId, async (tx) => {
                const result = { joined: 0, joinedNew: 0, made: new Map<string, string>() };
                for (const item of items) {
                    let companyId = item.companyId;
                    if (!companyId) {
                        // `createIn` refuses a domain a company took since the read: the chunk is retried on its own.
                        const made = await companies.createIn(tx, context, { name: item.domain, domain: item.domain });
                        await events.record(tx, { ...made.event, internal: true });
                        companyId = made.row.id;
                        result.made.set(item.domain, companyId);
                    }
                    for (const p of item.people) {
                        // A person a rep gave a company, or removed, since the read is left as the rep left them.
                        const still = await tx.person.findFirst({
                            where: { id: p.id, companyId: null, deletedAt: null },
                            select: { id: true },
                        });
                        if (!still) continue;
                        const updated = await people.updateIn(tx, context, p.id, { companyId });
                        if (updated.event) await events.record(tx, { ...updated.event, internal: true });
                        if (item.companyId || !result.made.has(item.domain)) result.joined += 1;
                        else result.joinedNew += 1;
                    }
                }
                return result;
            }),
        );
    const made = new Map<string, string>();
    const flush = async (items: Work[]): Promise<void> => {
        if (items.length === 0) return;
        try {
            const result = await write(items);
            report.joined += result.joined;
            report.joinedNew += result.joinedNew;
            report.created += result.made.size;
            for (const [domain, id] of result.made) made.set(domain, id);
        } catch (error) {
            // One refusal rolls the chunk back: each of its domains is tried alone, and only the refused one is left.
            if (items.length > 1) {
                for (const item of items) await flush([item]);
                return;
            }
            report.failed += items[0]!.people.length;
            progress(`refused: ${error instanceof Error ? error.message : String(error)}`);
        }
    };

    let chunk: Work[] = [];
    let size = 0;
    let done = 0;
    for (const item of work) {
        if (!item.companyId && new Set(item.people.map((p) => p.ownerId).filter(Boolean)).size > 1) {
            report.createdShared += 1;
        }
        for (let at = 0; at < item.people.length; at += WRITE_CHUNK) {
            const slice = item.people.slice(at, at + WRITE_CHUNK);
            if (at > 0) {
                // The rest of a large domain: on its own, at the company its first chunk made or found.
                await flush(chunk);
                chunk = [];
                size = 0;
                const companyId = item.companyId ?? made.get(item.domain) ?? null;
                // Its first chunk was refused: the rest would make the company again and be refused the same way.
                if (!companyId) report.failed += slice.length;
                else await flush([{ domain: item.domain, companyId, people: slice }]);
                continue;
            }
            chunk.push({ domain: item.domain, companyId: item.companyId, people: slice });
            size += slice.length;
            if (size >= WRITE_CHUNK) {
                await flush(chunk);
                chunk = [];
                size = 0;
            }
        }
        done += 1;
        if (done % 1000 === 0) {
            progress(
                `… ${done} of ${work.length} domains: ${report.joined + report.joinedNew} people linked, ${report.created} companies made, ${report.failed} people refused`,
            );
        }
    }
    await flush(chunk);

    // 4. The new companies name no owner: their first saver's, as for any company the import left without one.
    const fill = await assignCompanyOwners(app, workspaceId, {
        apply: true,
        reassignPeople: false,
        onProgress: progress,
    });
    report.ownersFilled = fill.assigned;
    return report;
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const slug = args[0];
    const flags = args.slice(1);
    const known = new Set(['--estimate', '--apply']);
    const apply = flags.includes('--apply');
    if (!slug || slug.startsWith('--') || flags.some((f) => !known.has(f)) || apply === flags.includes('--estimate')) {
        throw new Error(USAGE);
    }
    // A one-off process: no worker, relay or schedule of its own — the running API delivers what it records.
    for (const flag of [
        'WEBHOOK_WORKER',
        'MAIL_SYNC_WORKER',
        'MAIL_SEND_WORKER',
        'SEQUENCE_WORKER',
        'CALENDAR_SYNC_WORKER',
        'NOTIFICATIONS_WORKER',
        'TWENTY_IMPORT_WORKER',
        'ENRICHMENT_WORKER',
        'OUTBOX_RELAY',
        'TRANSACTIONAL_MAIL_RELAY',
    ]) {
        process.env[flag] = '0';
    }
    const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
    try {
        const workspace = await app.get(PrismaService).workspace.findUnique({ where: { slug }, select: { id: true } });
        if (!workspace) throw new Error(`no workspace ${slug}`);
        const report = await linkPeopleToCompanies(app, workspace.id, {
            apply,
            onProgress: (line) => console.error(line),
        });
        const would = apply ? '' : 'would be ';
        console.log(`${report.people} people with no company at ${report.domains} company domains`);
        console.log(`${would}linked to the company that has their domain: ${report.joined} people`);
        console.log(
            `${would}made: ${report.created} companies (${report.createdShared} whose people have more than one owner), with ${report.joinedNew} people linked to them`,
        );
        console.log(`${would}given their first saver as owner: ${report.ownersFilled} companies`);
        if (apply) console.log(`refused and left as they were: ${report.failed} people`);
        else console.log('estimate: nothing changed; add --apply to do it');
    } finally {
        await app.close();
    }
}

if (require.main === module) {
    main().catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
    });
}

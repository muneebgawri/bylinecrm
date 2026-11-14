import 'reflect-metadata';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { DomainEvents } from '../events/domain-events.service';
import { PrismaService } from '../infra/prisma.service';
import { RlsPrismaService } from '../infra/rls-prisma.service';
import { WorkspaceContext } from '../infra/workspace-context';
import { CompaniesService } from '../records/companies.service';
import { CompanyOwnership, normalisedDomain } from '../records/company-ownership';
import { PeopleService } from '../records/people.service';
import { importJobContext, JOB_WRITE_CHUNK, quietWorkers } from './job-common';

const USAGE = 'usage: node dist/cli/place-people.js <workspace-slug> --estimate|--apply < placements.csv';

/** One line of the file: a person, and the company a reviewed source says they work at. */
export interface Placement {
    personId: string;
    companyName: string;
    /** The company's website domain, when the source gives one; it finds the company before the name does. */
    companyDomain: string | null;
}

export interface PlaceReport {
    lines: number;
    /** People already at that company, or no longer live: nothing to do. */
    unchanged: number;
    missing: number;
    /** Placed at a company the workspace has, found by its domain or else by its exact name. */
    atExisting: number;
    /** Placed at a company made for them, owned by the person's owner. */
    atNew: number;
    companiesCreated: number;
    /** Of the placed: the company is another rep's, so the person shows in Settings → Ownership → Conflicts. */
    otherOwner: number;
}

/** The file: a header line, then `person_id,company_name,company_domain`, quoted as CSV quotes. */
export function parsePlacements(text: string): Placement[] {
    const rows: string[][] = [];
    for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        const cells: string[] = [];
        let cell = '';
        let quoted = false;
        for (let i = 0; i < line.length; i++) {
            const ch = line[i]!;
            if (quoted && ch === '"' && line[i + 1] === '"') {
                cell += '"';
                i++;
            } else if (ch === '"') {
                quoted = !quoted;
            } else if (ch === ',' && !quoted) {
                cells.push(cell);
                cell = '';
            } else {
                cell += ch;
            }
        }
        cells.push(cell);
        rows.push(cells.map((c) => c.trim()));
    }
    const [header, ...data] = rows;
    if (header?.join(',') !== 'person_id,company_name,company_domain') {
        throw new Error('the file must start with the header person_id,company_name,company_domain');
    }
    return data.map(([personId = '', companyName = '', domain = ''], i) => {
        if (!/^[0-9a-f-]{36}$/i.test(personId) || !companyName) throw new Error(`line ${i + 2} is not a placement`);
        return { personId, companyName, companyDomain: domain ? normalisedDomain(domain) : null };
    });
}

/**
 * Places people at the companies a reviewed file names — for people whose address names no company (a newswire's
 * media-contact alias, free mail) when a source such as their press release says where they work. The company is
 * the workspace's one at that domain (`companyForDomain`, as "Add lead" finds it), else the one with that exact
 * name, else a new one made with that name and domain and owned by the person's owner, as the first saver's would
 * be. The person is moved through the people service (`person.updated`, on their history); their owner is kept,
 * so one placed at another rep's company is counted and left for Settings → Ownership → Conflicts.
 * `JOB_WRITE_CHUNK` people per transaction. Re-running changes nothing once done. Counts only.
 */
export async function placePeople(
    app: INestApplicationContext,
    workspaceId: string,
    placements: readonly Placement[],
    options: { apply: boolean },
): Promise<PlaceReport> {
    const rls = app.get(RlsPrismaService);
    const people = app.get(PeopleService);
    const companies = app.get(CompaniesService);
    const ownership = app.get(CompanyOwnership);
    const events = app.get(DomainEvents);
    const scope = app.get(WorkspaceContext);
    const context = importJobContext(workspaceId);
    const report: PlaceReport = {
        lines: placements.length,
        unchanged: 0,
        missing: 0,
        atExisting: 0,
        atNew: 0,
        companiesCreated: 0,
        otherOwner: 0,
    };
    /** Companies this run made, by domain or name, so two people at one new firm share it. */
    const made = new Map<string, string>();
    const key = (p: Placement) => (p.companyDomain ? `d:${p.companyDomain}` : `n:${p.companyName.toLowerCase()}`);
    for (let at = 0; at < placements.length; at += JOB_WRITE_CHUNK) {
        const chunk = placements.slice(at, at + JOB_WRITE_CHUNK);
        // In the job's workspace scope: the record services read it (custom fields, the owner scope) as on a request.
        await scope.run(context, () =>
            rls.withWorkspace(workspaceId, async (tx) => {
                for (const p of chunk) {
                    const person = await tx.person.findFirst({
                        where: { id: p.personId, deletedAt: null },
                        select: { companyId: true, ownerId: true },
                    });
                    if (!person) {
                        report.missing += 1;
                        continue;
                    }
                    const byDomain = await ownership.companyForDomain(context, p.companyDomain);
                    const byName = byDomain
                        ? null
                        : await tx.company.findFirst({
                              where: { deletedAt: null, name: { equals: p.companyName, mode: 'insensitive' } },
                              orderBy: { createdAt: 'asc' },
                              select: { id: true, ownerId: true },
                          });
                    let companyId = byDomain?.companyId ?? byName?.id ?? made.get(key(p)) ?? null;
                    const companyOwner = byDomain ? byDomain.ownerId : (byName?.ownerId ?? null);
                    if (companyId && companyId === person.companyId) {
                        report.unchanged += 1;
                        continue;
                    }
                    if (companyId && !made.has(key(p))) {
                        report.atExisting += 1;
                        if (companyOwner && companyOwner !== person.ownerId) report.otherOwner += 1;
                    } else {
                        report.atNew += 1;
                    }
                    if (!options.apply) {
                        if (!companyId) made.set(key(p), 'estimate');
                        if (!companyId) report.companiesCreated += 1;
                        continue;
                    }
                    if (!companyId) {
                        const created = await companies.createIn(tx, context, {
                            name: p.companyName,
                            domain: p.companyDomain,
                            ownerId: person.ownerId,
                        });
                        await events.record(tx, { ...created.event, internal: true });
                        companyId = created.row.id;
                        made.set(key(p), companyId);
                        report.companiesCreated += 1;
                    }
                    const { event } = await people.updateIn(tx, context, p.personId, { companyId });
                    if (event) await events.record(tx, { ...event, internal: true });
                }
            }),
        );
    }
    return report;
}

export function parseArgs(args: readonly string[]): { slug: string; apply: boolean } | null {
    const [slug, flag, ...rest] = args;
    if (!slug || slug.startsWith('--') || rest.length > 0) return null;
    if (flag === '--estimate') return { slug, apply: false };
    if (flag === '--apply') return { slug, apply: true };
    return null;
}

async function readStdin(): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString('utf8');
}

/**
 * `node dist/cli/place-people.js <workspace-slug> --estimate|--apply < placements.csv` — run on the server in its own
 * container (`docker compose run -T`, the file on standard input). `--estimate` changes nothing.
 */
async function main(): Promise<void> {
    const parsed = parseArgs(process.argv.slice(2));
    if (!parsed) throw new Error(USAGE);
    const placements = parsePlacements(await readStdin());
    quietWorkers();
    const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
    try {
        const workspace = await app
            .get(PrismaService)
            .workspace.findUnique({ where: { slug: parsed.slug }, select: { id: true } });
        if (!workspace) throw new Error(`no workspace ${parsed.slug}`);
        const r = await placePeople(app, workspace.id, placements, { apply: parsed.apply });
        console.log(
            `${r.lines} lines: ${r.atExisting} ${parsed.apply ? 'placed' : 'would place'} at existing companies ` +
                `(${r.otherOwner} another rep's), ${r.atNew} at ${r.companiesCreated} new companies, ` +
                `${r.unchanged} already there, ${r.missing} not found`,
        );
        if (!parsed.apply) console.log('estimate: nothing changed; add --apply to do it');
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

import 'reflect-metadata';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { PrismaService } from '../infra/prisma.service';
import { RlsPrismaService } from '../infra/rls-prisma.service';
import { companyDomainOfAddress, normalisedDomain } from '../records/company-ownership';

const USAGE = 'usage: node dist/cli/link-domain-people.js <workspace-slug> --estimate|--apply [--batch <n>]';

/** People read per statement (`--batch`): a page, never the whole table. */
export const DEFAULT_BATCH = 1000;

export interface LinkOptions {
    /** Write: without it, nothing changes and the counts say what `--apply` would do. */
    apply: boolean;
    batch?: number | undefined;
    onProgress?: (line: string) => void;
}

export interface LinkReport {
    /** Live people with an address and no company, read. */
    read: number;
    /** Of those, people at a domain a live company has: linked (or that would be). */
    linked: number;
    /** The companies they were linked to. */
    companies: number;
}

/**
 * OWN-2g: links every live person with no company to the company at their address's domain — the one way OWN-2 reads
 * a domain (`companyDomainOfAddress`: registrable, never free mail; the company that has it as its own domain, the
 * oldest first, else as another domain). The Bigin import saved people without linking them, so their companies
 * read as having nobody (and ownership, OWN-2d, never reached them). A page of people (`batch`) per read; each page's
 * links are one short transaction, and only `company_id` changes: whose each person is does not, and no event is
 * written per person (a run says what it did in its report). Re-running changes nothing once done.
 */
export async function linkDomainPeople(
    app: INestApplicationContext,
    workspaceId: string,
    options: LinkOptions,
): Promise<LinkReport> {
    const owner = app.get(PrismaService);
    const rls = app.get(RlsPrismaService);
    const progress = options.onProgress ?? (() => undefined);
    const BATCH = options.batch ?? DEFAULT_BATCH;
    if (!Number.isInteger(BATCH) || BATCH < 1) throw new Error('batch must be a whole number of people, 1 or more');
    const report: LinkReport = { read: 0, linked: 0, companies: 0 };
    const touched = new Set<string>();
    const companyOf = new Map<string, string | null>();

    let after = '00000000-0000-0000-0000-000000000000';
    for (;;) {
        const page = await owner.$queryRaw<{ id: string; email: string }[]>`
            SELECT p.id::text AS id, p.email_primary AS email FROM people p
            WHERE p.workspace_id = ${workspaceId}::uuid AND p.company_id IS NULL AND p.deleted_at IS NULL
              AND p.email_primary IS NOT NULL AND p.id > ${after}::uuid
            ORDER BY p.id LIMIT ${BATCH}`;
        if (page.length === 0) break;
        report.read += page.length;
        after = page[page.length - 1]!.id;

        const keyed = page.flatMap((p) => {
            const key = companyDomainOfAddress(p.email);
            return key ? [{ id: p.id, key }] : [];
        });
        const unknown = [...new Set(keyed.map((p) => p.key))].filter((k) => !companyOf.has(k));
        if (unknown.length > 0)
            for (const [k, v] of await companiesFor(owner, workspaceId, unknown)) companyOf.set(k, v);

        const byCompany = new Map<string, string[]>();
        for (const p of keyed) {
            const company = companyOf.get(p.key);
            if (company) byCompany.set(company, [...(byCompany.get(company) ?? []), p.id]);
        }
        const ids = [...byCompany.values()].flat();
        for (const c of byCompany.keys()) touched.add(c);
        if (options.apply && ids.length > 0) {
            report.linked += await rls.withWorkspace(workspaceId, async (tx) => {
                let n = 0;
                for (const [company, people] of byCompany) {
                    n += await tx.$executeRaw`
                        UPDATE people SET company_id = ${company}::uuid, updated_at = now()
                        WHERE id = ANY(${people}::uuid[]) AND company_id IS NULL AND deleted_at IS NULL`;
                }
                return n;
            });
        } else {
            report.linked += ids.length;
        }
        progress(`… ${report.read} people read, ${report.linked} linked`);
    }
    report.companies = touched.size;
    return report;
}

/** The live company each domain is (as `CompanyOwnership.companyForDomain` reads it), or null for none. */
async function companiesFor(
    owner: PrismaService,
    workspaceId: string,
    keys: readonly string[],
): Promise<Map<string, string | null>> {
    const forms = keys.flatMap((k) => [k, `www.${k}`]);
    const own = await owner.$queryRaw<{ id: string; domain: string }[]>`
        SELECT c.id::text AS id, c.domain FROM companies c
        WHERE c.workspace_id = ${workspaceId}::uuid AND c.deleted_at IS NULL AND c.domain = ANY(${forms}::text[])
        ORDER BY c.created_at, c.id`;
    const other = await owner.$queryRaw<{ id: string; domain: string }[]>`
        SELECT d.company_id::text AS id, d.domain FROM company_domains d
        JOIN companies c ON c.id = d.company_id AND c.deleted_at IS NULL
        WHERE c.workspace_id = ${workspaceId}::uuid AND d.domain = ANY(${forms}::text[])
        ORDER BY d.company_id`;
    const found = new Map<string, string | null>(keys.map((k) => [k, null]));
    for (const rows of [own, other]) {
        for (const r of rows) {
            const key = normalisedDomain(r.domain);
            if (found.get(key) === null) found.set(key, r.id);
        }
    }
    return found;
}

/**
 * `node dist/cli/link-domain-people.js <workspace-slug> --estimate|--apply [--batch <n>]` — run on the server, inside
 * the api container, after a backup (see `linkDomainPeople`). `--estimate` changes nothing and prints what `--apply`
 * would do. A run that stops partway is rerun as it was. Then `assign-company-owners.js` fills the owners of the
 * companies those people reached.
 */
async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const slug = args[0];
    const flags = args.slice(1);
    const known = new Set(['--estimate', '--apply']);
    const apply = flags.includes('--apply');
    let batch: number | undefined;
    const at = flags.indexOf('--batch');
    if (at >= 0) {
        batch = Number(flags[at + 1]);
        if (!Number.isInteger(batch) || batch < 1) throw new Error(USAGE);
        flags.splice(at, 2);
    }
    if (!slug || slug.startsWith('--') || flags.some((f) => !known.has(f)) || apply === flags.includes('--estimate')) {
        throw new Error(USAGE);
    }
    // A one-off process: no worker, relay or schedule of its own.
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
        const report = await linkDomainPeople(app, workspace.id, {
            apply,
            batch,
            onProgress: (line) => console.error(line),
        });
        console.log(
            `${apply ? 'linked' : 'would link'}: ${report.linked} of ${report.read} people with no company, to ${report.companies} companies`,
        );
        if (!apply) console.log('estimate: nothing changed; add --apply to do it');
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

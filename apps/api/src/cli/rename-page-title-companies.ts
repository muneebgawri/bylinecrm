import 'reflect-metadata';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { DomainEvents } from '../events/domain-events.service';
import { PrismaService } from '../infra/prisma.service';
import { RlsPrismaService } from '../infra/rls-prisma.service';
import { WorkspaceContext } from '../infra/workspace-context';
import { CompaniesService } from '../records/companies.service';
import { normalisedDomain } from '../records/company-ownership';
import { importJobContext, quietWorkers } from './job-common';

const USAGE =
    'usage: node dist/cli/rename-page-title-companies.js <workspace-slug> --estimate|--apply [--delete-empty <domain,domain,…>]';

/**
 * A company name that is a web page's title, not a company's: what a site says before it has anything to say
 * (a host's placeholder, an error page, a login wall, a parked or seized domain). Whole-name matches only.
 */
export const PAGE_TITLE_NAME = new RegExp(
    '^(' +
        [
            'home',
            'home ?page',
            'welcome',
            'coming soon',
            'index of /',
            'default',
            'untitled',
            'just another wordpress site',
            'private site',
            'this website has been seized',
            'expireddomains\\.com',
            '(site )?under construction',
            '40[34] (not found|forbidden)',
            '(page )?not found',
            'access denied',
            'error',
            'loading\\.\\.\\.',
            'domain for sale',
            'account suspended',
            'website',
            'my (site|blog)',
            'blog',
            'test',
            'n/a',
            'none',
            'unknown',
            '-',
            '\\.',
            'company',
            'log ?in',
            'sign in',
            'attention required.*',
            'just a moment.*',
            'maintenance.*',
            '.* is for sale.*',
            'parked domain.*',
        ].join('|') +
        ')$',
    'i',
);

export interface RenameOptions {
    /** Write: without it, nothing changes and the counts say what `--apply` would do. */
    apply: boolean;
    /** Domains whose company is deleted when it has no people and no deals (a relay's, a bucket emptied by hand). */
    deleteEmpty?: readonly string[];
    onProgress?: (line: string) => void;
}

export interface RenameReport {
    /** Live companies whose name is a page title. */
    pageTitled: number;
    /** Of those, renamed to their domain. */
    renamed: number;
    /** Of those, left: they have no domain to be named for. */
    noDomain: number;
    /** `deleteEmpty`: companies deleted. */
    deleted: number;
    /** `deleteEmpty`: companies at a listed domain left alone because they have people or deals. */
    notEmpty: number;
    /** Companies left as they were: their chunk was refused (the reason is on stderr, no record named). */
    failed: number;
}

/**
 * The import brought in companies named for their site's page title ("Home", "Coming Soon", "Index of /"). Each
 * live one that has a domain is renamed to it, as "Add lead" and `link-people-to-companies` name a new company;
 * one without a domain has nothing truer to be called and is left. With `deleteEmpty`, the company at each listed
 * domain is deleted (softly, as from its page) when it has no live person and no live deal. Through the record
 * service, one per transaction, kept in BylineCRM (`internal`). Re-running changes nothing once done.
 */
export async function renamePageTitleCompanies(
    app: INestApplicationContext,
    workspaceId: string,
    options: RenameOptions,
): Promise<RenameReport> {
    const owner = app.get(PrismaService);
    const rls = app.get(RlsPrismaService);
    const scope = app.get(WorkspaceContext);
    const companies = app.get(CompaniesService);
    const events = app.get(DomainEvents);
    const context = importJobContext(workspaceId);
    const progress = options.onProgress ?? (() => undefined);
    const report: RenameReport = { pageTitled: 0, renamed: 0, noDomain: 0, deleted: 0, notEmpty: 0, failed: 0 };

    const rows = await owner.$queryRaw<{ id: string; name: string; domain: string | null; used: boolean }[]>`
        SELECT c.id::text AS id, c.name, c.domain,
               (EXISTS (SELECT 1 FROM people p WHERE p.company_id = c.id AND p.deleted_at IS NULL)
                OR EXISTS (SELECT 1 FROM opportunities d WHERE d.company_id = c.id AND d.deleted_at IS NULL)) AS used
        FROM companies c
        WHERE c.workspace_id = ${workspaceId}::uuid AND c.deleted_at IS NULL
        ORDER BY c.id`;
    const doomed = new Set((options.deleteEmpty ?? []).map((d) => normalisedDomain(d)));
    const renames: { id: string; name: string }[] = [];
    const deletes: string[] = [];
    for (const c of rows) {
        const domain = c.domain ? normalisedDomain(c.domain) : null;
        if (domain && doomed.has(domain)) {
            if (c.used) report.notEmpty += 1;
            else deletes.push(c.id);
            continue;
        }
        if (!PAGE_TITLE_NAME.test(c.name.trim())) continue;
        report.pageTitled += 1;
        if (!domain) report.noDomain += 1;
        else if (c.name !== domain) renames.push({ id: c.id, name: domain });
    }
    if (!options.apply) {
        report.renamed = renames.length;
        report.deleted = deletes.length;
        return report;
    }

    // A few hundred at most: each its own short transaction, so one refusal leaves the rest done.
    const each = async <T>(items: readonly T[], write: (item: T) => Promise<void>): Promise<number> => {
        let done = 0;
        for (const item of items) {
            try {
                await scope.run(context, () => write(item));
                done += 1;
            } catch (error) {
                report.failed += 1;
                progress(`refused: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        return done;
    };
    report.renamed = await each(renames, (c) =>
        rls.withWorkspace(workspaceId, async (tx) => {
            const updated = await companies.updateIn(tx, context, c.id, { name: c.name });
            if (updated.event) await events.record(tx, { ...updated.event, internal: true });
        }),
    );
    report.deleted = await each(deletes, (id) =>
        rls.withWorkspace(workspaceId, async (tx) => {
            const removed = await companies.removeIn(tx, context, id);
            await events.record(tx, { ...removed.event, internal: true });
        }),
    );
    return report;
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const slug = args[0];
    const flags = args.slice(1);
    let deleteEmpty: string[] | undefined;
    const at = flags.indexOf('--delete-empty');
    if (at >= 0) {
        deleteEmpty = (flags[at + 1] ?? '').split(',').filter(Boolean);
        if (deleteEmpty.length === 0) throw new Error(USAGE);
        flags.splice(at, 2);
    }
    const known = new Set(['--estimate', '--apply']);
    const apply = flags.includes('--apply');
    if (!slug || slug.startsWith('--') || flags.some((f) => !known.has(f)) || apply === flags.includes('--estimate')) {
        throw new Error(USAGE);
    }
    quietWorkers();
    const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
    try {
        const workspace = await app.get(PrismaService).workspace.findUnique({ where: { slug }, select: { id: true } });
        if (!workspace) throw new Error(`no workspace ${slug}`);
        const report = await renamePageTitleCompanies(app, workspace.id, {
            apply,
            ...(deleteEmpty ? { deleteEmpty } : {}),
            onProgress: (line) => console.error(line),
        });
        const would = apply ? '' : 'would be ';
        console.log(`${report.pageTitled} companies named for a page title`);
        console.log(`${would}renamed to their domain: ${report.renamed} (${report.noDomain} have no domain and stay)`);
        if (deleteEmpty) {
            console.log(`${would}deleted, empty: ${report.deleted} (${report.notEmpty} have people or deals and stay)`);
        }
        if (apply) console.log(`refused and left as they were: ${report.failed}`);
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

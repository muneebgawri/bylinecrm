import 'reflect-metadata';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { isFreeMailDomain } from '@bylinecrm/shared';
import { AppModule } from '../app.module';
import { DomainEvents } from '../events/domain-events.service';
import { PrismaService } from '../infra/prisma.service';
import { RlsPrismaService } from '../infra/rls-prisma.service';
import { CompaniesService } from '../records/companies.service';
import { PeopleService } from '../records/people.service';
import { importJobContext, JOB_WRITE_CHUNK, quietWorkers } from './job-common';

const USAGE = 'usage: node dist/cli/unlink-relay-companies.js <workspace-slug> --estimate|--apply';

export interface UnlinkReport {
    /** Live companies whose own domain names no company (free mail, a consumer provider, a service's relay). */
    companies: number;
    /** People taken off them: each keeps their owner and every other field. */
    people: number;
    /** Companies trashed once empty; one a deal still names is left for a person to decide. */
    trashed: number;
    keptForDeals: number;
}

/**
 * Undoes the companies a domain that names no company made (`isFreeMailDomain`): a free-mail provider, a consumer
 * mailbox, or a service's relay — `email4pr.com`, the newswire's media-contact aliases, put 433 people at different
 * firms under one company. Each person is taken off it through the people service (`person.updated`, on the
 * record's history), `JOB_WRITE_CHUNK` per transaction; their owner, deals and mail stay as they are. The empty
 * company then goes to Trash with reason `wrong_details`, unless a deal names it. Re-running changes nothing once
 * done. Counts only: no record is named.
 */
export async function unlinkRelayCompanies(
    app: INestApplicationContext,
    workspaceId: string,
    options: { apply: boolean; onProgress?: (line: string) => void },
): Promise<UnlinkReport> {
    const rls = app.get(RlsPrismaService);
    const people = app.get(PeopleService);
    const companies = app.get(CompaniesService);
    const events = app.get(DomainEvents);
    const context = importJobContext(workspaceId);
    const report: UnlinkReport = { companies: 0, people: 0, trashed: 0, keptForDeals: 0 };
    const candidates = (
        await rls.withWorkspace(workspaceId, (tx) =>
            tx.company.findMany({
                where: { deletedAt: null, domain: { not: null } },
                select: { id: true, domain: true },
            }),
        )
    ).filter((c) => c.domain !== null && isFreeMailDomain(c.domain));
    report.companies = candidates.length;
    for (const company of candidates) {
        const ids = (
            await rls.withWorkspace(workspaceId, (tx) =>
                tx.person.findMany({ where: { companyId: company.id, deletedAt: null }, select: { id: true } }),
            )
        ).map((p) => p.id);
        report.people += ids.length;
        if (!options.apply) continue;
        for (let at = 0; at < ids.length; at += JOB_WRITE_CHUNK) {
            const chunk = ids.slice(at, at + JOB_WRITE_CHUNK);
            await rls.withWorkspace(workspaceId, async (tx) => {
                for (const id of chunk) {
                    const { event } = await people.updateIn(tx, context, id, { companyId: null });
                    if (event) await events.record(tx, event);
                }
            });
            options.onProgress?.(`… ${Math.min(at + JOB_WRITE_CHUNK, ids.length)} of ${ids.length} people taken off`);
        }
        await rls.withWorkspace(workspaceId, async (tx) => {
            const named = await tx.opportunity.count({ where: { companyId: company.id, deletedAt: null } });
            const left = await tx.person.count({ where: { companyId: company.id, deletedAt: null } });
            if (named > 0 || left > 0) {
                report.keptForDeals += 1;
                return;
            }
            const { event } = await companies.removeIn(tx, context, company.id, {
                reason: 'wrong_details',
                note: 'Its domain names no company: free mail, a consumer provider or a relay service.',
            });
            await events.record(tx, event);
            report.trashed += 1;
        });
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

/**
 * `node dist/cli/unlink-relay-companies.js <workspace-slug> --estimate|--apply` — run on the server in its own
 * container. `--estimate` changes nothing and prints what `--apply` would do.
 */
async function main(): Promise<void> {
    const parsed = parseArgs(process.argv.slice(2));
    if (!parsed) throw new Error(USAGE);
    quietWorkers();
    const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
    try {
        const workspace = await app
            .get(PrismaService)
            .workspace.findUnique({ where: { slug: parsed.slug }, select: { id: true } });
        if (!workspace) throw new Error(`no workspace ${parsed.slug}`);
        const r = await unlinkRelayCompanies(app, workspace.id, {
            apply: parsed.apply,
            onProgress: (line) => console.error(line),
        });
        const verb = parsed.apply ? 'took' : 'would take';
        console.log(
            `${r.companies} companies at domains that name no company; ${verb} ${r.people} people off them` +
                (parsed.apply ? `; trashed ${r.trashed}, kept ${r.keptForDeals} a deal still names` : ''),
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

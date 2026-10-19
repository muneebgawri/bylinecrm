import { PrismaClient } from '@prisma/client';
import { parseEnv } from '../config/env';
import { companyDomain } from '../records/company-domain';

/**
 * `node dist/cli/normalise-company-domains.js [--apply]` — run once on the server, inside the api container, after
 * OWN-2c deploys. Rewrites every company's domain (and every company's other domain) to its registrable domain:
 * `uk.acme.com` becomes `acme.com`. The SQL migration already stripped `www.`; the Public Suffix List is not in
 * SQL, so the rest happens here. A row whose registrable domain another row in its workspace already has (live or
 * trashed) is left as it is and printed: two records of one company, for a person to merge or delete (Settings →
 * Ownership lists them). Without `--apply` it only prints what it would change. Uses the owner connection.
 */
async function main(): Promise<void> {
    const apply = process.argv.includes('--apply');
    const env = parseEnv(process.env);
    const db = new PrismaClient({ datasourceUrl: env.DATABASE_URL });
    const counts = { companies: 0, otherDomains: 0, duplicates: 0, unparsable: 0 };
    try {
        const companies = await db.company.findMany({
            where: { domain: { not: null } },
            select: { id: true, workspaceId: true, domain: true },
            orderBy: { createdAt: 'asc' },
        });
        const taken = new Set(companies.map((c) => `${c.workspaceId} ${c.domain}`));
        for (const c of companies) {
            const key = companyDomain(c.domain);
            if (!key) {
                counts.unparsable += 1;
                console.log(`company ${c.id}: "${c.domain}" has no registrable domain; left as it is`);
                continue;
            }
            if (key === c.domain) continue;
            if (taken.has(`${c.workspaceId} ${key}`)) {
                counts.duplicates += 1;
                console.log(`company ${c.id}: "${c.domain}" duplicates "${key}" in its workspace; merge by hand`);
                continue;
            }
            console.log(`company ${c.id}: "${c.domain}" -> "${key}"`);
            taken.delete(`${c.workspaceId} ${c.domain}`);
            taken.add(`${c.workspaceId} ${key}`);
            counts.companies += 1;
            if (apply) await db.company.update({ where: { id: c.id }, data: { domain: key } });
        }

        const others = await db.companyDomain.findMany({ select: { id: true, workspaceId: true, domain: true } });
        const takenOther = new Set(others.map((d) => `${d.workspaceId} ${d.domain}`));
        for (const d of others) {
            const key = companyDomain(d.domain);
            if (!key || key === d.domain) continue;
            if (takenOther.has(`${d.workspaceId} ${key}`) || taken.has(`${d.workspaceId} ${key}`)) {
                counts.duplicates += 1;
                console.log(`other domain ${d.id}: "${d.domain}" duplicates "${key}"; removed`);
                if (apply) await db.companyDomain.delete({ where: { id: d.id } });
                continue;
            }
            console.log(`other domain ${d.id}: "${d.domain}" -> "${key}"`);
            takenOther.delete(`${d.workspaceId} ${d.domain}`);
            takenOther.add(`${d.workspaceId} ${key}`);
            counts.otherDomains += 1;
            if (apply) await db.companyDomain.update({ where: { id: d.id }, data: { domain: key } });
        }
    } finally {
        await db.$disconnect();
    }
    // Always the outcome, zero included.
    console.log(
        `${apply ? 'changed' : 'would change'}: companies ${counts.companies}, other domains ${counts.otherDomains}; ` +
            `duplicates ${counts.duplicates}; unparsable ${counts.unparsable}`,
    );
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});

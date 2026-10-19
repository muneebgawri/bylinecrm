import { PrismaClient } from '@prisma/client';
import { parseEnv } from '../config/env';
import { duplicatePairs, EMPTY_COUNTS, mergeCompany, type MergeCounts } from '../records/merge-companies';

/**
 * `node dist/cli/merge-duplicate-companies.js [--apply]` — run on the server, inside the api container (OWN-2e,
 * #201). Merges every company saved twice under one registrable domain (`inter.ikea.com` beside `ikea.com`; the
 * Ownership page's "Same company saved twice") into the company it duplicates: people, deals, notes, tasks,
 * files, timeline, enrichment, transfer history and Twenty links move; the kept company takes what it lacks; the
 * duplicate goes to the trash (restorable). Each merge is its own transaction. Without `--apply` it runs every
 * merge and rolls it back, so the counts printed are exactly what `--apply` would do. Take a backup first.
 * Uses the owner connection (`DATABASE_URL`).
 */
async function main(): Promise<void> {
    const apply = process.argv.includes('--apply');
    const env = parseEnv(process.env);
    const db = new PrismaClient({ datasourceUrl: env.DATABASE_URL });
    const total: MergeCounts = { ...EMPTY_COUNTS };
    let merged = 0;
    let failed = 0;
    try {
        const pairs = await duplicatePairs(db);
        for (const pair of pairs) {
            try {
                const counts = await db.$transaction(async (tx) => {
                    const c = await mergeCompany(tx, pair);
                    if (!apply) throw new DryRun(c);
                    return c;
                });
                report(pair, counts);
                add(total, counts);
                merged += 1;
            } catch (error) {
                if (error instanceof DryRun) {
                    report(pair, error.counts);
                    add(total, error.counts);
                    merged += 1;
                    continue;
                }
                failed += 1;
                console.log(
                    `FAILED ${pair.duplicateDomain} -> ${pair.keptDomain}: ${error instanceof Error ? error.message : String(error)}`,
                );
            }
        }
    } finally {
        await db.$disconnect();
    }
    // Always the outcome, every kind and zero included.
    console.log(
        `${apply ? 'merged' : 'would merge'}: ${merged} companies, failed ${failed}; moved ` +
            Object.entries(total)
                .map(([k, v]) => `${k} ${v}`)
                .join(', '),
    );
    if (failed > 0) process.exit(1);
}

class DryRun extends Error {
    constructor(readonly counts: MergeCounts) {
        super('dry run');
    }
}

function report(
    pair: { duplicateDomain: string; keptDomain: string; duplicateId: string; keptId: string },
    c: MergeCounts,
) {
    const moved = Object.entries(c)
        .filter(([, v]) => v > 0)
        .map(([k, v]) => `${k} ${v}`)
        .join(', ');
    console.log(
        `${pair.duplicateDomain} (${pair.duplicateId}) -> ${pair.keptDomain} (${pair.keptId}): ${moved || 'nothing attached'}`,
    );
}

function add(total: MergeCounts, c: MergeCounts): void {
    for (const key of Object.keys(total) as (keyof MergeCounts)[]) total[key] += c[key];
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});

import { PrismaClient } from '@prisma/client';
import { ENRICHMENT_OBJECTS, type EnrichmentObject } from '@bylinecrm/shared';
import { Queue } from 'bullmq';
import { parseEnv } from '../config/env';
import { ENRICHMENT_JOB_OPTIONS, ENRICHMENT_QUEUE } from '../enrichment/enrichment.constants';
import { EnrichmentQueue, type EnrichmentJob } from '../enrichment/enrichment-queue';

/**
 * `node dist/cli/enrich-records.js [--object person|company] [--workspace <id>] [--force] [--apply]` — run on
 * the server, inside the api container. Puts every live record (of one kind, in one workspace, when named) on
 * the enrichment queue through `EnrichmentQueue`, the same way _Enrich now_ and the sweep do: one job per
 * record, the workers ask at their own pace. Without `--force` a record is asked only the sources that are due
 * — a source never asked before (one just added) and any answer older than the workspace's age; `--force`
 * asks every source again. Without `--apply` it only counts. Uses the owner connection.
 */
async function main(): Promise<void> {
    const arg = (name: string) => {
        const at = process.argv.indexOf(`--${name}`);
        return at >= 0 ? process.argv[at + 1] : undefined;
    };
    const apply = process.argv.includes('--apply');
    const force = process.argv.includes('--force');
    const workspaceId = arg('workspace');
    const only = arg('object');
    if (only !== undefined && !(ENRICHMENT_OBJECTS as readonly string[]).includes(only)) {
        throw new Error(`--object must be one of ${ENRICHMENT_OBJECTS.join(', ')}`);
    }
    const objects = (only ? [only] : ENRICHMENT_OBJECTS) as readonly EnrichmentObject[];

    const env = parseEnv(process.env);
    const db = new PrismaClient({ datasourceUrl: env.DATABASE_URL });
    const queue = new Queue<EnrichmentJob>(ENRICHMENT_QUEUE, {
        connection: { url: env.REDIS_URL, maxRetriesPerRequest: null },
        defaultJobOptions: ENRICHMENT_JOB_OPTIONS,
    });
    const enrichment = new EnrichmentQueue(queue);
    const counts: Record<string, { records: number; queued: number }> = {};
    try {
        for (const object of objects) {
            const where = { deletedAt: null, ...(workspaceId ? { workspaceId } : {}) };
            const select = { id: true, workspaceId: true } as const;
            const rows =
                object === 'person'
                    ? await db.person.findMany({ where, select, orderBy: { createdAt: 'asc' } })
                    : await db.company.findMany({ where, select, orderBy: { createdAt: 'asc' } });
            const count = { records: rows.length, queued: 0 };
            counts[object] = count;
            if (!apply) continue;
            for (const row of rows) {
                if (await enrichment.enqueue({ workspaceId: row.workspaceId, object, recordId: row.id, force })) {
                    count.queued += 1;
                }
            }
        }
    } finally {
        await queue.close();
        await db.$disconnect();
    }
    // Always the outcome, zero included; a record not queued already had a job waiting or running.
    for (const [object, c] of Object.entries(counts)) {
        console.log(`${object}: ${c.records} records, ${apply ? `${c.queued} queued` : 'would queue (dry run)'}`);
    }
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});

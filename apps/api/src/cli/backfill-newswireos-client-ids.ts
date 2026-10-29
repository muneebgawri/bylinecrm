import { PrismaClient } from '@prisma/client';
import { parseEnv } from '../config/env';
import { customerIdOf, keepNewswireosClient } from '../invoices/newswireos-client-ids';

/** Events read per batch: the backfill walks the table in pages, never all at once. */
const BATCH = 500;

/**
 * `node dist/cli/backfill-newswireos-client-ids.js --workspace <id> [--apply]` (INV-2) — gives the people and
 * companies NewswireOS's timeline events already named their NewswireOS client id, as the hook now does for every
 * new event (`keepNewswireosClient`, `fill`: a record that has its client keeps it). Newest events first, so a record
 * named by several takes the latest. Job code, not a migration: batched, resumable (run it again; it only fills
 * gaps), and it never holds the table. Without `--apply` it only counts (the dry run). Uses the owner connection.
 */
async function main(): Promise<void> {
    const apply = process.argv.includes('--apply');
    const workspaceId = arg('--workspace');
    if (!workspaceId) throw new Error('usage: --workspace <id> [--apply]');
    const env = parseEnv(process.env);
    const db = new PrismaClient({ datasourceUrl: env.DATABASE_URL });
    const counts = { events: 0, named: 0, filled: 0 };
    // A record named by several events is counted (and filled) once: the newest event's client.
    const seen = new Set<string>();
    try {
        let cursor: string | undefined;
        for (;;) {
            const events = await db.newswireosTimelineEvent.findMany({
                where: { workspaceId, targetId: { not: null }, targetType: { in: ['person', 'company'] } },
                orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                take: BATCH,
                ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
                select: { id: true, targetType: true, targetId: true, payload: true },
            });
            if (events.length === 0) break;
            cursor = events[events.length - 1]!.id;
            counts.events += events.length;
            for (const e of events) {
                const customerId = customerIdOf(e.payload);
                if (!customerId) continue;
                counts.named += 1;
                const record = { type: e.targetType as 'person' | 'company', id: e.targetId! };
                if (seen.has(record.id)) continue;
                seen.add(record.id);
                if (apply) {
                    if (await keepNewswireosClient(db, record, customerId)) counts.filled += 1;
                } else {
                    const has =
                        record.type === 'person'
                            ? await db.person.count({ where: { id: record.id, newswireosCustomerId: null } })
                            : await db.company.count({ where: { id: record.id, newswireosCustomerId: null } });
                    counts.filled += has;
                }
            }
        }
    } finally {
        await db.$disconnect();
    }
    const verb = apply ? '' : 'would ';
    console.log(
        `events ${counts.events}, naming a client ${counts.named}: ${verb}give ${counts.filled} record(s) their NewswireOS client id`,
    );
}

function arg(name: string): string | undefined {
    const at = process.argv.indexOf(name);
    return at > 0 ? process.argv[at + 1] : undefined;
}

if (require.main === module) {
    main().catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : error);
        process.exit(1);
    });
}

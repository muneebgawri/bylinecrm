import { PrismaClient } from '@prisma/client';
import { parseEnv } from '../config/env';

/** People recorded per statement: small enough that a batch never holds `people` long. */
const BATCH = 1000;

/**
 * `node dist/cli/backfill-person-addresses.js` — run once on the server, inside the api container, after the
 * `person_addresses` migration deploys. Records the additional addresses of every person saved before it, a batch
 * at a time (the `people_additional_addresses_sync` trigger keeps every write from then on). Re-running changes
 * nothing once done. Uses the owner connection (`DATABASE_URL`).
 */
async function main(): Promise<void> {
    const owner = new PrismaClient({ datasourceUrl: parseEnv(process.env).DATABASE_URL });
    let people = 0;
    let recorded = 0;
    let after = '00000000-0000-0000-0000-000000000000';
    try {
        for (;;) {
            const batch = await owner.$queryRaw<{ id: string }[]>`
                SELECT id FROM people WHERE id > ${after}::uuid ORDER BY id LIMIT ${BATCH}`;
            if (batch.length === 0) break;
            const ids = batch.map((b) => b.id);
            recorded += await owner.$executeRaw`
                INSERT INTO person_addresses (person_id, workspace_id, address, person_created_at)
                SELECT p.id, p.workspace_id, lower(e), p.created_at
                FROM people p
                CROSS JOIN LATERAL jsonb_array_elements_text(
                    CASE WHEN jsonb_typeof(p.emails -> 'additional') = 'array' THEN p.emails -> 'additional' ELSE '[]'::jsonb END
                ) AS e
                WHERE p.id = ANY(${ids}::uuid[]) AND e <> ''
                ON CONFLICT DO NOTHING`;
            people += batch.length;
            after = ids[ids.length - 1]!;
            if (people % (BATCH * 20) === 0) console.log(`… ${people} people`);
        }
        console.log(`done: ${people} people read, ${recorded} addresses recorded`);
    } finally {
        await owner.$disconnect();
    }
}

main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
});

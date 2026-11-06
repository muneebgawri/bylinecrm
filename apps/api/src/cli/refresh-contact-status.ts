import { PrismaClient } from '@prisma/client';
import { parseEnv } from '../config/env';

/** People re-derived per statement: small enough that a batch never holds `people` long. */
const BATCH = 1000;

/**
 * `node dist/cli/refresh-contact-status.js [--workspace <id>]` — run on the server, inside the api container, after a
 * change to what `refresh_contact_status()` counts deploys (the migration replaces the function and re-derives
 * nothing). Re-derives every person's contact status, attempts and last contact (or one workspace's), a batch of
 * people per statement — each its own short transaction. Re-running changes nothing once done. Uses the owner
 * connection (`DATABASE_URL`), which row-level security does not restrict.
 */
async function main(): Promise<void> {
    const at = process.argv.indexOf('--workspace');
    const workspaceId = at > 0 ? (process.argv[at + 1] ?? null) : null;
    const owner = new PrismaClient({ datasourceUrl: parseEnv(process.env).DATABASE_URL });
    let people = 0;
    let changed = 0;
    let after = '00000000-0000-0000-0000-000000000000';
    try {
        for (;;) {
            const batch = await owner.$queryRaw<{ id: string }[]>`
                SELECT id FROM people
                WHERE id > ${after}::uuid AND (${workspaceId}::uuid IS NULL OR workspace_id = ${workspaceId}::uuid)
                ORDER BY id LIMIT ${BATCH}`;
            if (batch.length === 0) break;
            const ids = batch.map((b) => b.id);
            const [row] = await owner.$queryRaw<{ changed: number }[]>`
                SELECT refresh_contact_status(${ids}::uuid[]) AS changed`;
            changed += Number(row?.changed ?? 0);
            people += batch.length;
            after = ids[ids.length - 1]!;
            if (people % (BATCH * 20) === 0) console.log(`… ${people} people, ${changed} changed`);
        }
        console.log(`done: ${people} people read, ${changed} changed`);
    } finally {
        await owner.$disconnect();
    }
}

main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
});

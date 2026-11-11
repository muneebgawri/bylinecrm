import { PrismaClient } from '@prisma/client';
import { parseEnv } from '../config/env';

/** Copies filled per statement: small enough that each holds its row locks for well under a second. */
const BATCH = 2_000;

/**
 * `node dist/cli/backfill-copy-sent-at.js [--apply]` — run once on the server, inside the api container, after the
 * migration that added `mail_message_copies.sent_at` deploys. Fills each copy written before it with its message's
 * `sent_at`, a batch at a time in id order (one short statement each, so sync's writes are never held up), until none
 * is left. Without `--apply` it only counts what it would fill. Uses the owner connection: every workspace's copies.
 * Safe to run again or to stop: it fills only what is still null.
 */
async function main(): Promise<void> {
    const apply = process.argv.includes('--apply');
    const env = parseEnv(process.env);
    const db = new PrismaClient({ datasourceUrl: env.DATABASE_URL });
    try {
        const missing = await countMissing(db);
        console.log(`${missing} copies without sent_at`);
        if (!apply) {
            console.log('dry run: pass --apply to fill them');
            return;
        }
        let after = '00000000-0000-0000-0000-000000000000';
        let filled = 0;
        for (;;) {
            const rows = await db.$queryRaw<{ id: string }[]>`
                WITH batch AS (
                    SELECT c.id FROM mail_message_copies c
                    WHERE c.id > ${after}::uuid AND c.sent_at IS NULL
                    ORDER BY c.id
                    LIMIT ${BATCH}
                )
                UPDATE mail_message_copies c SET sent_at = m.sent_at
                FROM batch b, mail_messages m
                WHERE c.id = b.id AND m.id = c.message_id
                RETURNING c.id`;
            if (rows.length === 0) break;
            filled += rows.length;
            after = rows.reduce((max, r) => (r.id > max ? r.id : max), after);
            if (filled % (BATCH * 25) < BATCH) console.log(`${filled} filled`);
        }
        console.log(`done: ${filled} filled, ${await countMissing(db)} still without sent_at`);
    } finally {
        await db.$disconnect();
    }
}

async function countMissing(db: PrismaClient): Promise<number> {
    const rows = await db.$queryRaw<{ missing: number }[]>`
        SELECT count(*)::int AS missing FROM mail_message_copies WHERE sent_at IS NULL`;
    return rows[0]?.missing ?? 0;
}

main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
});

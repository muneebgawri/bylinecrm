import { PrismaClient } from '@prisma/client';
import { parseEnv } from '../config/env';

const USAGE = 'usage: node dist/cli/release-merged-addresses.js --estimate|--apply [--batch <n>]';

/** People read and written per statement: small enough that a batch never holds `people` long. */
export const DEFAULT_BATCH = 500;

const FIRST_ID = '00000000-0000-0000-0000-000000000000';

export interface ReleaseMergedReport {
    /** Merged-away people (trashed, `merged_into_id` set) still holding an address. */
    people: number;
    /** Of those, how many gave their addresses up (`--apply`). */
    released: number;
}

/**
 * A person merged into another gives up every address: what they held is the survivor's (`people-dedupe`'s merge
 * clears the duplicate before the survivor takes them). People merged before that rule kept copies, and an address
 * is one person's, trash included (`people_address_taken`) — so when the survivor later lets an address go, the
 * merged-away copy still holds it and nobody can save a person with it, nor find who has it.
 *
 * This clears the addresses of every merged-away person, a batch at a time, by id. The `people` triggers keep
 * `person_addresses` and the primary-address index in step. A person deleted by a member is not touched: it holds
 * its address until it is restored or removed. Re-running changes nothing once done. Counts only: nobody is named.
 */
export async function releaseMergedAddresses(
    owner: PrismaClient,
    options: { apply: boolean; batch?: number | undefined; onProgress?: (line: string) => void },
): Promise<ReleaseMergedReport> {
    const batch = options.batch ?? DEFAULT_BATCH;
    if (!Number.isInteger(batch) || batch < 1) throw new Error('batch must be a whole number of people, 1 or more');
    const report: ReleaseMergedReport = { people: 0, released: 0 };
    let after = FIRST_ID;
    for (;;) {
        const page = await owner.$queryRaw<{ id: string }[]>`
            SELECT id::text FROM people
             WHERE id > ${after}::uuid AND deleted_at IS NOT NULL AND merged_into_id IS NOT NULL
               AND (NULLIF(emails ->> 'primary', '') IS NOT NULL
                    OR (jsonb_typeof(emails -> 'additional') = 'array' AND jsonb_array_length(emails -> 'additional') > 0))
             ORDER BY id LIMIT ${batch}`;
        if (page.length === 0) break;
        const ids = page.map((p) => p.id);
        report.people += ids.length;
        if (options.apply) {
            // The conditions again, under the write's own lock: a person restored since the read is left alone.
            report.released += await owner.$executeRaw`
                UPDATE people SET emails = '{"primary": null, "additional": []}'::jsonb, updated_at = now()
                 WHERE id::text = ANY(${ids}) AND deleted_at IS NOT NULL AND merged_into_id IS NOT NULL`;
        }
        after = ids[ids.length - 1]!;
        options.onProgress?.(`… ${report.people} people`);
    }
    return report;
}

/**
 * `node dist/cli/release-merged-addresses.js --estimate|--apply [--batch <n>]` — run on the server, inside the api
 * container. `--estimate` writes nothing. Uses the owner connection (`DATABASE_URL`): every workspace, in batches.
 */
async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const apply = args.includes('--apply');
    if (apply === args.includes('--estimate')) throw new Error(USAGE);
    const at = args.indexOf('--batch');
    const batch = at >= 0 ? Number(args[at + 1]) : undefined;
    const owner = new PrismaClient({ datasourceUrl: parseEnv(process.env).DATABASE_URL });
    try {
        const report = await releaseMergedAddresses(owner, { apply, batch, onProgress: (line) => console.log(line) });
        console.log(
            apply
                ? `done: ${report.released} of ${report.people} merged-away people gave up their addresses`
                : `estimate: ${report.people} merged-away people still hold addresses; --apply releases them`,
        );
    } finally {
        await owner.$disconnect();
    }
}

if (require.main === module) {
    main().catch((err: unknown) => {
        console.error(err);
        process.exit(1);
    });
}

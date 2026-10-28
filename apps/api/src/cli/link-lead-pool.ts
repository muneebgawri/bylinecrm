import { PrismaClient } from '@prisma/client';
import { parseEnv } from '../config/env';

const USAGE =
    'usage: node dist/cli/link-lead-pool.js <pool-name> <workspace-slug>... | node dist/cli/link-lead-pool.js --leave <workspace-slug>';

/** People recorded per statement: small enough that a batch never holds `people` long. */
const BATCH = 1000;

/**
 * `node dist/cli/link-lead-pool.js <pool-name> <workspace-slug>...` — run on the server, inside the api
 * container, by the operator. Puts the workspaces in one lead pool (made if new): from then on a live
 * person's primary email in one of them cannot be saved in another (`people_lead_pool_claim`). Then
 * records the live people already there, a batch at a time; addresses saved in two of them before
 * they were pooled are counted, and both people kept. Re-running changes nothing once done.
 *
 * `--leave <workspace-slug>` takes a workspace out of its pool, and its addresses with it.
 *
 * Uses the owner connection (`DATABASE_URL`).
 */
async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const owner = new PrismaClient({ datasourceUrl: parseEnv(process.env).DATABASE_URL });
    try {
        if (args[0] === '--leave') {
            if (args.length !== 2) throw new Error(USAGE);
            await leave(owner, args[1]!);
            return;
        }
        const [name, ...slugs] = args;
        if (!name || name.startsWith('--') || slugs.length === 0) throw new Error(USAGE);
        await link(owner, name, slugs);
    } finally {
        await owner.$disconnect();
    }
}

async function workspaceBySlug(owner: PrismaClient, slug: string): Promise<{ id: string; name: string }> {
    const workspace = await owner.workspace.findUnique({ where: { slug }, select: { id: true, name: true } });
    if (!workspace) throw new Error(`no workspace ${slug}`);
    return workspace;
}

async function link(owner: PrismaClient, name: string, slugs: string[]): Promise<void> {
    const workspaces = [];
    for (const slug of slugs) workspaces.push(await workspaceBySlug(owner, slug));
    const pool = await owner.leadPool.upsert({ where: { name }, create: { name }, update: {} });
    for (const workspace of workspaces) {
        await owner.workspace.update({ where: { id: workspace.id }, data: { leadPoolId: pool.id } });
        let recorded = 0;
        let after = '00000000-0000-0000-0000-000000000000';
        for (;;) {
            // The trigger keeps every write from here on; this records the people saved before.
            const rows = await owner.$queryRaw<{ id: string }[]>`
                INSERT INTO lead_pool_addresses (person_id, pool_id, workspace_id, email)
                SELECT p.id, ${pool.id}::uuid, p.workspace_id, p.email_primary
                FROM people p
                WHERE p.workspace_id = ${workspace.id}::uuid AND p.id > ${after}::uuid
                  AND p.deleted_at IS NULL AND p.email_primary IS NOT NULL
                ORDER BY p.id
                LIMIT ${BATCH}
                ON CONFLICT (person_id) DO UPDATE SET pool_id = EXCLUDED.pool_id, email = EXCLUDED.email
                RETURNING person_id AS id`;
            if (rows.length === 0) break;
            recorded += rows.length;
            after = rows
                .map((r) => r.id)
                .sort()
                .at(-1)!;
        }
        console.log(`${workspace.name}: in lead pool ${name}, ${recorded} addresses recorded`);
    }
    const [shared] = await owner.$queryRaw<{ count: number }[]>`
        SELECT count(DISTINCT email)::int AS count FROM (
            SELECT email FROM lead_pool_addresses WHERE pool_id = ${pool.id}::uuid
            GROUP BY email HAVING count(DISTINCT workspace_id) > 1
        ) shared`;
    console.log(`${shared?.count ?? 0} addresses were already saved in more than one workspace of ${name} (both kept)`);
}

async function leave(owner: PrismaClient, slug: string): Promise<void> {
    const workspace = await workspaceBySlug(owner, slug);
    await owner.$transaction([
        owner.workspace.update({ where: { id: workspace.id }, data: { leadPoolId: null } }),
        owner.leadPoolAddress.deleteMany({ where: { workspaceId: workspace.id } }),
    ]);
    console.log(`${workspace.name}: out of its lead pool`);
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});

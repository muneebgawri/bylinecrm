import { PrismaClient } from '@prisma/client';

/**
 * `node dist/cli/seed-search-scale.js` — a LOCAL database at production's shape for profiling people search (#344):
 * ~165k fake people across two workspaces, 99% in one, about 3% with additional addresses (as production holds
 * them), then ANALYZE. Only ever against a throwaway database: it refuses one holding any workspace it did not make.
 * Re-running replaces its own two workspaces. Uses the owner connection (`DATABASE_URL`).
 *
 * Then, as the app role (the owner bypasses row-level security and looks fast):
 *   SET ROLE bylinecrm_app; SET app.workspace_id = '<big workspace id it prints>';
 *   EXPLAIN (ANALYZE, BUFFERS) <the search>;
 */

const TOTAL = 165_000;
const BIG_SHARE = 0.99;
const BATCH = 10_000;
const SLUGS = ['seed-search-big', 'seed-search-small'] as const;

const FIRST = [
    'james',
    'mary',
    'john',
    'patricia',
    'robert',
    'jennifer',
    'michael',
    'linda',
    'david',
    'elizabeth',
    'william',
    'barbara',
    'richard',
    'susan',
    'joseph',
    'jessica',
    'thomas',
    'sarah',
    'charles',
    'karen',
    'matt',
    'nancy',
    'daniel',
    'lisa',
    'mark',
    'betty',
    'paul',
    'sandra',
    'steven',
    'ashley',
    'andrew',
    'kim',
    'josh',
    'emily',
];
const LAST = [
    'smith',
    'johnson',
    'williams',
    'brown',
    'jones',
    'garcia',
    'miller',
    'davis',
    'rodriguez',
    'martinez',
    'hernandez',
    'lopez',
    'gonzalez',
    'wilson',
    'anderson',
    'thomas',
    'taylor',
    'moore',
    'jackson',
    'martin',
    'lee',
    'perez',
    'thompson',
    'white',
    'harris',
    'sanchez',
    'clark',
    'ramirez',
    'lewis',
    'robinson',
    'walker',
    'young',
];
const TITLES = ['ceo', 'founder', 'marketing director', 'head of pr', 'editor', 'communications manager', 'cto', null];

async function main(): Promise<void> {
    const url = process.env['DATABASE_URL'];
    if (!url) throw new Error('DATABASE_URL is not set');
    const db = new PrismaClient({ datasourceUrl: url });
    try {
        const { others } = (
            await db.$queryRaw<{ others: number }[]>`
            SELECT count(*)::int AS others FROM workspaces WHERE slug <> ALL(${[...SLUGS]}::text[])`
        )[0]!;
        if (others > 0) {
            throw new Error(
                `refusing: this database holds ${others} other workspace(s); seed a throwaway database only`,
            );
        }
        await db.$executeRaw`DELETE FROM workspaces WHERE slug = ANY(${[...SLUGS]}::text[])`;
        const sizes = [Math.round(TOTAL * BIG_SHARE), TOTAL - Math.round(TOTAL * BIG_SHARE)];
        for (const [i, slug] of SLUGS.entries()) {
            const { id } = (
                await db.$queryRaw<{ id: string }[]>`
                INSERT INTO workspaces (id, slug, name, updated_at)
                VALUES (gen_random_uuid(), ${slug}, ${slug}, now()) RETURNING id::text`
            )[0]!;
            for (let from = 0; from < sizes[i]!; from += BATCH) {
                const to = Math.min(from + BATCH, sizes[i]!) - 1;
                // emails.additional on ~3% of people: the people_additional_addresses_sync trigger fills person_addresses.
                await db.$executeRaw`
                    INSERT INTO people (id, workspace_id, name_first, name_last, job_title, emails, created_by, updated_at)
                    SELECT gen_random_uuid(), ${id}::uuid, f, l, (${TITLES}::text[])[1 + (n % ${TITLES.length})],
                           jsonb_build_object(
                               'primary', f || '.' || l || n || '@' || 'company' || (n % 9000) || '.com',
                               'additional', CASE WHEN abs(hashint4(n + 13)) % 100 < 3
                                   THEN jsonb_build_array(f || n || '@mail' || (n % 50) || '.com')
                                   ELSE '[]'::jsonb END),
                           '{"kind":"system","id":null}'::jsonb, now()
                    FROM generate_series(${from + i * 1_000_000}::int, ${to + i * 1_000_000}::int) AS n,
                         -- Deterministic per row (a hash of n): the same database every run.
                         LATERAL (SELECT (${FIRST}::text[])[1 + abs(hashint4(n)) % ${FIRST.length}] AS f,
                                         (${LAST}::text[])[1 + abs(hashint4(n * 7 + 1)) % ${LAST.length}] AS l) AS names`;
            }
            console.log(`${slug}: ${sizes[i]} people, workspace ${id}`);
        }
        await db.$executeRawUnsafe('ANALYZE people');
        await db.$executeRawUnsafe('ANALYZE person_addresses');
        const { addresses } = (
            await db.$queryRaw<{ addresses: number }[]>`
            SELECT count(*)::int AS addresses FROM person_addresses`
        )[0]!;
        console.log(`done: ${TOTAL} people, ${addresses} additional addresses, analyzed`);
    } finally {
        await db.$disconnect();
    }
}

main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
});

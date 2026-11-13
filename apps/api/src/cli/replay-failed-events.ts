import { PrismaClient } from '@prisma/client';
import { parseEnv } from '../config/env';

const USAGE =
    'usage: node dist/cli/replay-failed-events.js <workspace-slug> --type <event type> [--since <ISO time>] [--apply]';

export interface ReplayOptions {
    workspaceId: string;
    type: string;
    /** Only events recorded at or after this time; all of the type when absent. */
    since?: Date | undefined;
    apply: boolean;
}

export interface ReplayReport {
    /** Failed events of the type (and time) found. */
    found: number;
    /** Events put back for delivery; 0 on a dry run. */
    replayed: number;
}

/**
 * Puts a workspace's failed outbox events of one type back for delivery (#389): their failure marks go, their attempts
 * start over, and the running API's relay delivers them again from the next scan — through the same consumers, with
 * the same idempotency, as any event. For events a consumer could not finish before a fix (a re-match that ran out of
 * memory), once the fix is deployed. Uses the owner connection: the app role cannot rewrite outbox rows.
 */
export async function replayFailedEvents(owner: PrismaClient, options: ReplayOptions): Promise<ReplayReport> {
    const where = {
        workspaceId: options.workspaceId,
        type: options.type,
        failedAt: { not: null },
        ...(options.since ? { createdAt: { gte: options.since } } : {}),
    };
    const found = await owner.outboxEvent.count({ where });
    if (!options.apply || found === 0) return { found, replayed: 0 };
    const { count } = await owner.outboxEvent.updateMany({
        where,
        data: { failedAt: null, attempts: 0, nextAttemptAt: null, leaseUntil: null, lastError: null },
    });
    return { found, replayed: count };
}

export function parseArgs(argv: readonly string[]): {
    slug: string;
    type: string;
    since?: Date | undefined;
    apply: boolean;
} {
    const slug = argv[0];
    if (!slug || slug.startsWith('--')) throw new Error(USAGE);
    let type: string | undefined;
    let since: Date | undefined;
    let apply = false;
    for (let i = 1; i < argv.length; i += 1) {
        const arg = argv[i]!;
        if (arg === '--apply') apply = true;
        else if (arg === '--type' && argv[i + 1]) type = argv[(i += 1)];
        else if (arg === '--since' && argv[i + 1]) {
            since = new Date(argv[(i += 1)]!);
            if (Number.isNaN(since.getTime())) throw new Error(USAGE);
        } else throw new Error(USAGE);
    }
    if (!type) throw new Error(USAGE);
    return { slug, type, since, apply };
}

/**
 * `node dist/cli/replay-failed-events.js <workspace-slug> --type <event type> [--since <ISO time>] [--apply]` — run on
 * the server, inside the api container. Without `--apply` it only counts.
 */
async function main(): Promise<void> {
    const { slug, type, since, apply } = parseArgs(process.argv.slice(2));
    const owner = new PrismaClient({ datasourceUrl: parseEnv(process.env).DATABASE_URL });
    try {
        const workspace = await owner.workspace.findUnique({ where: { slug }, select: { id: true } });
        if (!workspace) throw new Error(`no workspace ${slug}`);
        const report = await replayFailedEvents(owner, { workspaceId: workspace.id, type, since, apply });
        console.log(`${report.found} failed ${type} event(s)${since ? ` since ${since.toISOString()}` : ''}`);
        console.log(
            apply
                ? `replayed ${report.replayed}: the API's relay delivers them from its next scan`
                : 'dry run: nothing changed; add --apply to replay them',
        );
    } finally {
        await owner.$disconnect();
    }
}

if (require.main === module) {
    main().catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
    });
}

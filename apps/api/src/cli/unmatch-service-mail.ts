import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { DomainEvents } from '../events/domain-events.service';
import { PrismaService } from '../infra/prisma.service';
import { RlsPrismaService } from '../infra/rls-prisma.service';
import { SERVICE_ONLY, rematchMessage } from '../mail-sync/matching';
import { reconcileMessageTargets } from '../mail-sync/reconcile';

const USAGE = 'usage: node dist/cli/unmatch-service-mail.js <workspace-slug> [--apply]';

/** Messages re-matched per transaction: small enough that a batch never holds the timeline long. */
const BATCH = 100;

/**
 * `node dist/cli/unmatch-service-mail.js <workspace-slug> [--apply]` — run once on the server, inside the api
 * container. Mail only service inboxes hold is matched to no one (SVC-1), but mail matched before that rule, or left
 * only in a service inbox when a member's copy went, still names people and sits on their records. This re-matches
 * each such message through the one rule (`rematchMessage`), so its participants point at no one and its timeline
 * entries on those people, their companies and deals go. Without `--apply` it only counts. Re-running changes nothing
 * once done.
 */
async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const slug = args[0];
    const apply = args.includes('--apply');
    if (!slug || slug.startsWith('--') || args.some((a) => a.startsWith('--') && a !== '--apply')) {
        throw new Error(USAGE);
    }
    // A one-off process: no worker, relay or schedule of its own — the running API delivers what it records.
    for (const flag of [
        'WEBHOOK_WORKER',
        'MAIL_SYNC_WORKER',
        'MAIL_SEND_WORKER',
        'SEQUENCE_WORKER',
        'CALENDAR_SYNC_WORKER',
        'NOTIFICATIONS_WORKER',
        'TWENTY_IMPORT_WORKER',
        'ENRICHMENT_WORKER',
        'OUTBOX_RELAY',
        'TRANSACTIONAL_MAIL_RELAY',
    ]) {
        process.env[flag] = '0';
    }
    const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
    try {
        const owner = app.get(PrismaService);
        const workspace = await owner.workspace.findUnique({ where: { slug }, select: { id: true } });
        if (!workspace) throw new Error(`no workspace ${slug}`);
        const [count] = await owner.$queryRaw<{ messages: number; links: number; people: number }[]>`
            SELECT count(DISTINCT mp.message_id)::int AS messages, count(*)::int AS links,
                   count(DISTINCT mp.person_id)::int AS people
            FROM mail_participants mp
            WHERE mp.workspace_id = ${workspace.id}::uuid AND mp.person_id IS NOT NULL AND ${SERVICE_ONLY}`;
        console.log(
            `${count!.messages} messages only service inboxes hold still name ${count!.people} people (${count!.links} links)`,
        );
        if (!apply) {
            console.log('dry run: nothing changed; add --apply to unmatch them');
            return;
        }

        const rls = app.get(RlsPrismaService);
        const events = app.get(DomainEvents);
        let after = '00000000-0000-0000-0000-000000000000';
        let messages = 0;
        let changed = 0;
        for (;;) {
            const batch = await owner.$queryRaw<{ message_id: string }[]>`
                SELECT DISTINCT mp.message_id
                FROM mail_participants mp
                WHERE mp.workspace_id = ${workspace.id}::uuid AND mp.person_id IS NOT NULL
                  AND mp.message_id > ${after}::uuid AND ${SERVICE_ONLY}
                ORDER BY mp.message_id
                LIMIT ${BATCH}`;
            if (batch.length === 0) break;
            const ids = batch.map((b) => b.message_id);
            changed += await rls.withWorkspace(workspace.id, async (tx) => {
                const touched: string[] = [];
                for (const id of ids) touched.push(...(await rematchMessage(tx, id)));
                await events.recordAll(tx, await reconcileMessageTargets(tx, workspace.id, touched));
                return touched.length;
            });
            messages += ids.length;
            after = ids[ids.length - 1]!;
            console.error(`… ${messages} messages`);
        }
        console.log(`done: ${messages} messages read, ${changed} unmatched`);
    } finally {
        await app.close();
    }
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
});

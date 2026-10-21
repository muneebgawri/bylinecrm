import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { BiginReuseReconciler, printReconcileReport, type ReuseLogRow } from '../bigin-import/reuse-reconciler';
import { PrismaService } from '../infra/prisma.service';

/**
 * `node dist/cli/reconcile-bigin-reuse.js <workspace-slug> [--logs <file.jsonl>] [--apply]` — FR-CRMS-26, run once
 * on the server inside the api container after BIGIN-1: splits the people the old Bigin → Twenty job mixed when a
 * Bigin Contact was reused for someone else (`BiginReuseReconciler`). Without `--apply` it is a dry run: each
 * Contact's change is made in a transaction and rolled back, so the counts are exact. Re-running changes nothing.
 * `--logs` is JSON lines of `{ biginId, ts, email, firstName, lastName }` from the old job's logs. The domain events
 * go to the outbox; the API's relay delivers them (mail re-links by address, the timeline, webhooks).
 */
async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const slug = args[0];
    const apply = args.includes('--apply');
    const logsAt = args.indexOf('--logs');
    const logsFile = logsAt >= 0 ? args[logsAt + 1] : undefined;
    if (!slug || slug.startsWith('--') || (logsAt >= 0 && !logsFile)) {
        throw new Error(
            'usage: node dist/cli/reconcile-bigin-reuse.js <workspace-slug> [--logs <file.jsonl>] [--apply]',
        );
    }
    const logs = logsFile ? readLogs(logsFile) : [];
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
        const workspace = await app.get(PrismaService).workspace.findUnique({ where: { slug }, select: { id: true } });
        if (!workspace) throw new Error(`no workspace ${slug}`);
        const report = await app.get(BiginReuseReconciler).reconcile(workspace.id, {
            apply,
            logs,
            // stderr, so the report on stdout stays clean to redirect.
            progress: (line) => console.error(`${new Date().toISOString()} ${line}`),
        });
        printReconcileReport(report);
    } finally {
        await app.close();
    }
}

function readLogs(file: string): ReuseLogRow[] {
    return readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line, index) => {
            try {
                return JSON.parse(line) as ReuseLogRow;
            } catch {
                throw new Error(`${file}:${index + 1} is not JSON`);
            }
        });
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});

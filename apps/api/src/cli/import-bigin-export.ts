import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { BiginImportRunView } from '@bylinecrm/shared';
import { AppModule } from '../app.module';
import { BiginExportImport, exportCliArgs } from '../bigin-import/export-run';
import { PrismaService } from '../infra/prisma.service';

const USAGE = 'usage: node dist/cli/import-bigin-export.js <workspace-slug> <export-dir> [--timezone <IANA zone>]';

/**
 * `node dist/cli/import-bigin-export.js <workspace-slug> <export-dir> [--timezone <zone>]` — BIGIN-1, run by the
 * operator inside the api container, after copying the extracted Bigin backup export (the directory holding `Data/`
 * and `Metadata/`) into it. Runs a full import of the workspace from the export in this process (`BiginExportImport`):
 * the API importer's run, links and report, then each deal's stage history and the logged emails onto the
 * timelines. Re-running updates what is there and adds nothing twice; a run this process left unfinished is
 * resumed. The export's times are read in its backup's time zone (`Metadata/BackupDetails.properties`) unless
 * `--timezone` says otherwise. Prints the report's counts — never a record.
 */
async function main(): Promise<void> {
    const parsed = exportCliArgs(process.argv.slice(2));
    if (!parsed) throw new Error(USAGE);
    const { slug, dir, timeZone } = parsed;
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
        const run = await app.get(BiginExportImport).run(workspace.id, dir, { timeZone });
        printRunCounts(run);
        if (run.status !== 'succeeded') process.exitCode = 1;
    } finally {
        await app.close();
    }
}

/** The run's outcome and, per phase, its counts: what an operator checks, with no record's data in it. */
export function printRunCounts(run: BiginImportRunView): void {
    console.log(`run ${run.id}: ${run.status}${run.error ? ` (${run.error})` : ''}`);
    const columns = ['remote', 'read', 'created', 'updated', 'unchanged', 'merged', 'skipped', 'failed'] as const;
    console.log(['phase', ...columns, 'after'].join('\t'));
    for (const entry of run.report) {
        console.log(
            [entry.object, ...columns.map((c) => entry[c] ?? '-'), entry.after ?? '-', ''].join('\t').trimEnd(),
        );
    }
    const unknown = [...new Set(run.report.flatMap((r) => r.unknownStages.map((u) => u.stage)))];
    if (unknown.length > 0)
        console.log(`stages with no stage here (placed in the first open stage): ${unknown.length}`);
    console.log(`accounts created: ${run.accountsCreated}`);
}

if (require.main === module) {
    main().catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : error);
        process.exit(1);
    });
}

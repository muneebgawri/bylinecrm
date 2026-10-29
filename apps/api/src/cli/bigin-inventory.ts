import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { BiginInventoryService, type BiginInventory } from '../bigin-import/bigin-inventory';
import { PrismaService } from '../infra/prisma.service';

/**
 * `node dist/cli/bigin-inventory.js <workspace-slug> [--json]` — BIGIN-1, before the cutover: what the workspace's
 * Bigin account holds against what BylineCRM imported (`BiginInventoryService`). Only reads, in Bigin and here;
 * run it inside the api container. `--json` prints the inventory as it is, for a record of the cutover.
 */
async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const slug = args[0];
    if (!slug || slug.startsWith('--'))
        throw new Error('usage: node dist/cli/bigin-inventory.js <workspace-slug> [--json]');
    // A one-off read: no worker, relay or schedule of its own.
    for (const flag of [
        'WEBHOOK_WORKER',
        'MAIL_SYNC_WORKER',
        'MAIL_SEND_WORKER',
        'SEQUENCE_WORKER',
        'CALENDAR_SYNC_WORKER',
        'NOTIFICATIONS_WORKER',
        'TWENTY_IMPORT_WORKER',
        'ENRICHMENT_WORKER',
        'INVOICE_WORKER',
        'OUTBOX_RELAY',
        'TRANSACTIONAL_MAIL_RELAY',
    ]) {
        process.env[flag] = '0';
    }
    const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
    try {
        const workspace = await app.get(PrismaService).workspace.findUnique({ where: { slug }, select: { id: true } });
        if (!workspace) throw new Error(`no workspace ${slug}`);
        const inventory = await app.get(BiginInventoryService).take(workspace.id);
        if (args.includes('--json')) console.log(JSON.stringify(inventory, null, 2));
        else print(inventory);
    } finally {
        await app.close();
    }
}

export function print(inventory: BiginInventory): void {
    console.log(`Bigin inventory, ${inventory.checkedAt}`);
    console.log('\nmodule                     in Bigin   imported   in BylineCRM');
    for (const m of [...inventory.modules].sort(
        (a, b) => Number(b.imported) - Number(a.imported) || (b.remote ?? -1) - (a.remote ?? -1),
    )) {
        const remote = m.remote === null ? `? (${m.error ?? 'no count'})` : String(m.remote);
        console.log(
            `${m.label.padEnd(26).slice(0, 26)} ${remote.padStart(9)}   ${(m.imported ? 'yes' : 'no').padEnd(8)}   ${m.linked === null ? '-' : m.linked}`,
        );
    }
    const left = inventory.customFields.filter((f) => !f.carried);
    console.log(`\ncustom fields: ${inventory.customFields.length}, not carried over: ${left.length}`);
    for (const f of left) console.log(`  ${f.module}.${f.apiName} (${f.label}, ${f.type})`);
    console.log(
        `\ndeal pipelines (${inventory.pipelines.length}): ${inventory.pipelines.join(', ') || '(one, or not listed)'}`,
    );
    console.log(`deal stages (${inventory.stages.length}): ${inventory.stages.join(', ')}`);
}

if (require.main === module) {
    main().catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : error);
        process.exit(1);
    });
}

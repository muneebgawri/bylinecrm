import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { readBiginConnection } from '../bigin-import/bigin-import.settings';
import { BIGIN_PORT, type BiginApi, type BiginRecord } from '../bigin-import/bigin.port';
import { suppressBiginOptOuts } from '../bigin-import/opt-outs';
import { PrismaService } from '../infra/prisma.service';
import { RlsPrismaService } from '../infra/rls-prisma.service';
import { SecretBox } from '../infra/secret-box';
import { SuppressionService } from '../suppression/suppression.service';

/** Pages of 200 read at most: 10,000 opted-out Contacts, far past any account's. */
const MAX_PAGES = 50;

/**
 * `node dist/cli/bigin-suppress-opt-outs.js <workspace-slug> [--apply]` — BIGIN-1, once: every Contact that opted out
 * of email in Bigin, found by Bigin's search (`Email_Opt_Out:equals:true`), goes on the suppression list as its
 * unsubscribe (`suppressBiginOptOuts`, which the importer now applies to each page of Contacts it reads). For the
 * Contacts imported before the importer read the flag. Without `--apply` it only counts (the dry run); re-running
 * changes nothing. Run inside the api container. Prints counts only, never an address.
 */
async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const slug = args[0];
    const apply = args.includes('--apply');
    if (!slug || slug.startsWith('--'))
        throw new Error('usage: node dist/cli/bigin-suppress-opt-outs.js <workspace-slug> [--apply]');
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
        const stored = await app
            .get(RlsPrismaService)
            .withWorkspace(workspace.id, (tx) => readBiginConnection(tx, app.get(SecretBox)));
        if (!stored) throw new Error('Bigin is not connected in this workspace');
        const bigin = app.get<BiginApi>(BIGIN_PORT);
        const opted: BiginRecord[] = [];
        for (let page = 1; page <= MAX_PAGES; page++) {
            const found = await bigin.search(stored.connection, 'Contacts', '(Email_Opt_Out:equals:true)', page);
            opted.push(...found.records);
            if (!found.moreRecords) break;
        }
        const suppression = app.get(SuppressionService);
        const addresses = [
            ...new Set(
                opted.flatMap((r) =>
                    [r.Email, r.Secondary_Email].filter((v): v is string => typeof v === 'string' && v.includes('@')),
                ),
            ),
        ].map((a) => a.trim().toLowerCase());
        const before = await suppression.check(workspace.id, addresses);
        if (apply) await suppressBiginOptOuts(suppression, workspace.id, opted);
        const verb = apply ? '' : 'would ';
        console.log(
            `opted out in Bigin: ${opted.length} contact(s), ${addresses.length} address(es); ` +
                `already suppressed ${before.size}; ${verb}suppress ${addresses.length - before.size}`,
        );
    } finally {
        await app.close();
    }
}

if (require.main === module) {
    main().catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : error);
        process.exit(1);
    });
}

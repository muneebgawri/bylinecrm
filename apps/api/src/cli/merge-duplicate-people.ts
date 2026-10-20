import 'reflect-metadata';
import { writeFileSync } from 'node:fs';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { PrismaService } from '../infra/prisma.service';
import { PeopleDedupe, type DedupeGroupResult, type DedupeReport } from '../records/people-dedupe.service';

const USAGE =
    'usage: node dist/cli/merge-duplicate-people.js <workspace-slug> [--apply] [--include-review] [--limit <n>] [--csv <file>]';

/**
 * `node dist/cli/merge-duplicate-people.js <workspace-slug> [--apply] [--include-review] [--limit <n>] [--csv <file>]`
 * — run on the server inside the api container. Merges people saved more than once (the 2026-10-12 Twenty
 * import's duplicates, `PeopleDedupe`). Tiers: `auto` (the people share an address) and `review` (only the name
 * and the company or work domain agree). Without `--apply` it is a dry run: each merge is made and rolled back,
 * so the counts are exact. `--apply` merges the auto tier only, unless `--include-review`. `--limit` caps the
 * merges of one run; each group is its own transaction and merged people go to the trash, so re-running resumes
 * where it stopped and changes nothing once done. `--csv` writes every group (survivor, owner and why). The domain
 * events go to the outbox; the running API's relay delivers them (timeline, webhooks). Take a backup first.
 */
async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const slug = args[0];
    const apply = args.includes('--apply');
    const includeReview = args.includes('--include-review');
    const value = (flag: string) => {
        const at = args.indexOf(flag);
        if (at < 0) return undefined;
        const v = args[at + 1];
        if (!v || v.startsWith('--')) throw new Error(USAGE);
        return v;
    };
    const csv = value('--csv');
    const limitArg = value('--limit');
    const limit = limitArg === undefined ? undefined : Number(limitArg);
    if (!slug || slug.startsWith('--') || (limit !== undefined && !(Number.isInteger(limit) && limit > 0))) {
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
        const workspace = await app.get(PrismaService).workspace.findUnique({ where: { slug }, select: { id: true } });
        if (!workspace) throw new Error(`no workspace ${slug}`);
        let seen = 0;
        const report = await app.get(PeopleDedupe).run(workspace.id, {
            apply,
            includeReview,
            limit,
            onGroup: () => {
                seen += 1;
                if (seen % 50 === 0) console.error(`… ${seen} groups`);
            },
        });
        printReport(report);
        if (csv) {
            writeFileSync(csv, toCsv(report.groups));
            console.log(`wrote ${report.groups.length} groups to ${csv}`);
        }
        if (report.failed > 0) process.exitCode = 1;
    } finally {
        await app.close();
    }
}

function printReport(report: DedupeReport): void {
    const { auto, review } = report.tiers;
    console.log(`auto (shared email): ${auto.groups} groups, ${auto.people} people`);
    console.log(`review (same name + company/domain): ${review.groups} groups, ${review.people} people`);
    const sample = report.groups.slice(0, 25);
    for (const g of sample) console.log(line(g));
    if (report.groups.length > sample.length) console.log(`… and ${report.groups.length - sample.length} more (--csv)`);
    // Always the outcome, every kind and zero included.
    console.log(
        `${report.applied ? 'merged' : 'would merge'}: ${report.merged} groups, failed ${report.failed}; moved ` +
            Object.entries(report.totals)
                .map(([k, v]) => `${k} ${v}`)
                .join(', '),
    );
}

function line(g: DedupeGroupResult): string {
    return (
        `[${g.tier}] ${g.outcome}: keep "${g.survivorName}" (${g.survivorId}) ← ${g.mergedNames.map((n, i) => `"${n}" (${g.mergedIds[i]})`).join(', ')}` +
        ` | owner ${g.owner ?? 'none'} — ${g.ownerWhy} | ${g.why}${g.biginIds.length ? ` | bigin ${g.biginIds.join(' ')}` : ''}`
    );
}

function toCsv(groups: readonly DedupeGroupResult[]): string {
    const head = [
        'tier',
        'outcome',
        'survivor_id',
        'survivor_name',
        'merged_ids',
        'merged_names',
        'emails',
        'bigin_ids',
        'owner_member_id',
        'owner',
        'owner_why',
        'why',
    ];
    const cell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const rows = groups.map((g) =>
        [
            g.tier,
            g.outcome,
            g.survivorId,
            g.survivorName,
            g.mergedIds.join(' '),
            g.mergedNames.join(' | '),
            g.emails.join(' '),
            g.biginIds.join(' '),
            g.ownerId ?? '',
            g.owner ?? '',
            g.ownerWhy,
            g.why,
        ]
            .map(cell)
            .join(','),
    );
    return [head.join(','), ...rows].join('\n') + '\n';
}

main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});

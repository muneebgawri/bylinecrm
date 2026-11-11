import 'reflect-metadata';
import { readFileSync, writeFileSync } from 'node:fs';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { PrismaService } from '../infra/prisma.service';
import {
    PeopleDedupe,
    type AddressReport,
    type DedupeGroupResult,
    type DedupeReport,
} from '../records/people-dedupe.service';

const USAGE =
    'usage: node dist/cli/merge-duplicate-people.js <workspace-slug> [--apply] [--include-review | --release-addresses [--keep <file>]] [--limit <n>] [--csv <file>]';

/**
 * `node dist/cli/merge-duplicate-people.js <workspace-slug> [--apply] [--include-review | --release-addresses [--keep <file>]] [--limit <n>] [--csv <file>]`
 * — run on the server inside the api container. Merges people saved more than once (the 2026-10-12 Twenty
 * import's duplicates, `PeopleDedupe`). Tiers: `auto` (the people share an address and their names agree),
 * `auto_name_mismatch` (they share an address but the names differ — listed in the CSV, never merged) and `review` (only the name
 * and the company or work domain agree). Without `--apply` it is a dry run: each merge is made and rolled back,
 * so the counts are exact. `--apply` merges the auto tier only, unless `--include-review`. `--limit` caps the
 * merges of one run; each group is its own transaction and merged people go to the trash, so re-running resumes
 * where it stopped and changes nothing once done. `--csv` writes every group (survivor, owner and why). The domain
 * events go to the outbox; the running API's relay delivers them (timeline, webhooks). Take a backup first.
 *
 * `--release-addresses` merges nothing: for the `auto_name_mismatch` groups, each shared address goes to the person
 * it names and the others give it up (`PeopleDedupe.releaseAddresses`); the rest are listed as unresolved. Dry run
 * unless `--apply`; `--csv` writes one row per shared address. `--keep` reads a person's choices for unresolved
 * addresses: a CSV with `email` and `keeper_id` columns (the `--csv` file, edited, will do); each such address goes
 * to that keeper, mail or not.
 */
async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const slug = args[0];
    const apply = args.includes('--apply');
    const includeReview = args.includes('--include-review');
    const releaseAddresses = args.includes('--release-addresses');
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
    const keep = value('--keep');
    if (
        !slug ||
        slug.startsWith('--') ||
        (limit !== undefined && !(Number.isInteger(limit) && limit > 0)) ||
        (releaseAddresses && (includeReview || limit !== undefined)) ||
        (keep !== undefined && !releaseAddresses)
    ) {
        throw new Error(USAGE);
    }
    const decided = keep === undefined ? undefined : keepers(readFileSync(keep, 'utf8'));
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
        const progress = () => {
            seen += 1;
            if (seen % 50 === 0) console.error(`… ${seen} groups`);
        };
        if (releaseAddresses) {
            const report = await app.get(PeopleDedupe).releaseAddresses(workspace.id, {
                apply,
                decided,
                onGroup: progress,
            });
            console.log(
                `${apply ? 'released' : 'would release'}: ${report.released} addresses; unresolved ${report.unresolved}; failed ${report.failed}`,
            );
            if (csv) {
                writeFileSync(csv, addressCsv(report));
                console.log(`wrote ${report.addresses.length} addresses to ${csv}`);
            }
            if (report.failed > 0) process.exitCode = 1;
            return;
        }
        const report = await app.get(PeopleDedupe).run(workspace.id, {
            apply,
            includeReview,
            limit,
            onGroup: progress,
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
    const { auto, auto_name_mismatch: mismatch, review } = report.tiers;
    console.log(`auto (shared email, names agree): ${auto.groups} groups, ${auto.people} people`);
    console.log(
        `auto_name_mismatch (shared email, names differ; never merged): ${mismatch.groups} groups, ${mismatch.people} people`,
    );
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

/** `--keep`: address → keeper id, from a CSV with `email` and `keeper_id` columns (no quoted commas in either). */
function keepers(text: string): Map<string, string> {
    const [head, ...rows] = text.split(/\r?\n/).filter((l) => l.trim() !== '');
    const cols = (head ?? '').split(',').map((c) => c.trim().toLowerCase());
    const e = cols.indexOf('email');
    const k = cols.indexOf('keeper_id');
    if (e < 0 || k < 0) throw new Error('--keep: the CSV needs email and keeper_id columns');
    const out = new Map<string, string>();
    for (const row of rows) {
        const cells = row.split(',');
        const email = cells[e]?.trim().toLowerCase();
        const id = cells[k]?.trim();
        if (!email || !id) continue;
        if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error(`--keep: ${email} has no keeper id`);
        if (out.has(email) && out.get(email) !== id) throw new Error(`--keep: ${email} has two keepers`);
        out.set(email, id);
    }
    return out;
}

const cell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

function addressCsv(report: AddressReport): string {
    const head = ['email', 'outcome', 'keeper_id', 'keeper_name', 'from_ids', 'from_names', 'why'];
    const rows = report.addresses.map((a) =>
        [a.email, a.outcome, a.keeperId ?? '', a.keeperName ?? '', a.fromIds.join(' '), a.fromNames.join(' | '), a.why]
            .map(cell)
            .join(','),
    );
    return [head.join(','), ...rows].join('\n') + '\n';
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

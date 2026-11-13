import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { PrismaService } from '../infra/prisma.service';
import { MailboxTokens } from '../mail-accounts/mailbox-tokens.service';
import { GMAIL_PORT, type GmailPort } from '../mail-sync/gmail.port';
import { MAIL_HISTORY_FLOOR_DEFAULT } from '../mail-sync/mail-sync.constants';
import { quietWorkers } from './job-common';

const USAGE = 'usage: node dist/cli/probe-mail-history.js <workspace-slug> [--before <YYYY-MM-DD>]';

/** Gmail's first month: nothing a mailbox holds is older. */
export const GMAIL_EPOCH = new Date('2004-04-01T00:00:00Z');

/** Whether the mailbox holds any message sent before `before`. */
export type HasMailBefore = (before: Date) => Promise<boolean>;

/**
 * The first calendar month (UTC) in which a mailbox holds mail, found by halving the months between Gmail's first and
 * `before` — about eight questions per mailbox, each one `messages.list` page. `null` when nothing is older than
 * `before`. Reads `before` as the start of its month.
 */
export async function oldestMonth(hasMailBefore: HasMailBefore, before: Date): Promise<Date | null> {
    const monthsBetween = (a: Date, b: Date) =>
        (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
    const monthAt = (offset: number) =>
        new Date(Date.UTC(GMAIL_EPOCH.getUTCFullYear(), GMAIL_EPOCH.getUTCMonth() + offset, 1));
    const end = monthsBetween(GMAIL_EPOCH, before);
    if (end <= 0 || !(await hasMailBefore(monthAt(end)))) return null;
    // Invariant: mail exists before monthAt(high); none before monthAt(low).
    let low = 0;
    let high = end;
    while (high - low > 1) {
        const mid = Math.floor((low + high) / 2);
        if (await hasMailBefore(monthAt(mid))) high = mid;
        else low = mid;
    }
    return monthAt(low);
}

/**
 * `node dist/cli/probe-mail-history.js <workspace-slug> [--before <date>]` — run on the server, inside the api
 * container. Asks Gmail, for each connected mailbox, whether it holds mail older than the history floor (the backfill's
 * default, or `--before`) and from which month: what another backfill with an earlier floor would find. Reads only;
 * one page per question, so a mailbox costs about eight list calls.
 */
async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const slug = args[0];
    const at = args.indexOf('--before');
    const before = new Date(at > 0 ? (args[at + 1] ?? '') : MAIL_HISTORY_FLOOR_DEFAULT);
    if (!slug || slug.startsWith('--') || Number.isNaN(before.getTime())) throw new Error(USAGE);
    quietWorkers();
    const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
    try {
        const owner = app.get(PrismaService);
        const tokens = app.get(MailboxTokens);
        const gmail = app.get<GmailPort>(GMAIL_PORT);
        const workspace = await owner.workspace.findUnique({ where: { slug }, select: { id: true } });
        if (!workspace) throw new Error(`no workspace ${slug}`);
        const mailboxes = await owner.mailbox.findMany({
            where: { workspaceId: workspace.id, transport: 'gmail', status: 'connected', purpose: { not: 'service' } },
            select: { id: true, email: true },
            orderBy: { email: 'asc' },
        });
        console.log(`${mailboxes.length} mailbox(es); anything before ${before.toISOString().slice(0, 10)}?`);
        let older = 0;
        for (const mailbox of mailboxes) {
            try {
                const token = await tokens.getAccessToken(workspace.id, mailbox.id);
                const hasMailBefore: HasMailBefore = async (date) =>
                    (await gmail.listMessages(token, { query: `before:${Math.floor(date.getTime() / 1000)}` })).messages
                        .length > 0;
                const oldest = await oldestMonth(hasMailBefore, before);
                if (oldest) older += 1;
                console.log(
                    `${mailbox.email}\t${oldest ? `oldest ${oldest.toISOString().slice(0, 7)}` : 'nothing older'}`,
                );
            } catch (error) {
                console.log(`${mailbox.email}\tfailed: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        console.log(`${older} of ${mailboxes.length} mailbox(es) hold older mail`);
    } finally {
        await app.close();
    }
}

if (require.main === module) {
    main().catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
    });
}

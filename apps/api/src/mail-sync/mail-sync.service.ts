import { Inject, Injectable, Logger } from '@nestjs/common';
import { blocklistCovers, type DomainEvent, type EmailSummary, type MailSyncStatus } from '@bylinecrm/shared';
import { Prisma } from '@prisma/client';
import { DomainEvents } from '../events/domain-events.service';
import { uniqueViolation } from '../infra/prisma-errors';
import { RlsPrismaService, type WorkspaceClient } from '../infra/rls-prisma.service';
import { MailboxTokens, MailboxUnavailable } from '../mail-accounts/mailbox-tokens.service';
import { GMAIL_PORT, GmailApiError, type GmailPort, type GmailRawMessage } from './gmail.port';
import {
    GMAIL_FETCH_CONCURRENCY,
    GMAIL_LIST_PAGE_SIZE,
    GMAIL_UNITS,
    MAIL_INITIAL_SYNC_DAYS,
    MAIL_RESYNC_MARGIN_MS,
    SENT_LABEL,
    SKIPPED_LABELS,
} from './mail-sync.constants';
import { membersByAddress, personsByAddress, recordTargetsForPeople } from './matching';
import { parseGmailMessage, type ParsedMessage } from './parse-message';
import { GmailQuota } from './quota';
import { withGmailRetry, type RetryOptions } from './retry';

type MailboxRow = Prisma.MailboxGetPayload<object>;

/** How a run went: what it imported, and what it passed over and why. */
export interface SyncRunResult {
    /** `initial`: the first import; `incremental`: from the history cursor; `recovered`: the cursor had expired and the mailbox was re-listed; `skipped`: the mailbox could not be used. */
    mode: 'initial' | 'incremental' | 'recovered' | 'skipped';
    imported: number;
    /** Already stored (a repeat in Gmail's history, or a run that overlapped). */
    duplicates: number;
    /** Drafts, spam, trash and chats. */
    skippedByLabel: number;
    /** Every outside participant blocklisted. */
    blocked: number;
}

/** Why the last run stopped, as kept on the sync state. Never a token or a raw Google body. */
type SyncErrorRecord = {
    code: string;
    message: string;
    at: string;
};

/** Thrown inside a run when Gmail no longer has history after the stored cursor. */
class HistoryExpired extends Error {}

/** A message ready to store: parsed, classified, and confirmed not blocklisted. */
interface Incoming {
    parsed: ParsedMessage;
    direction: 'inbound' | 'outbound';
}

/**
 * Mail sync (P2-2, FR-CRMS-2): imports what a connected Gmail mailbox holds and keeps up with it.
 * The first run imports the last `MAIL_INITIAL_SYNC_DAYS` days; later runs follow Gmail's history
 * from the stored cursor; a cursor Gmail has forgotten (`404`) is recovered by re-listing from the
 * last good sync. Every Gmail request takes from the mailbox's quota window and retries a
 * transient failure with backoff. A message is stored once (unique per mailbox), its participants
 * matched to people and members, and announced as `email.received` / `email.sent` on the records
 * it concerns — which is what puts it on their timelines, exactly once.
 *
 * Runs outside any request (a worker job): the workspace is passed explicitly and no owner scope
 * applies — sync sees every person in the workspace, as matching must.
 */
@Injectable()
export class MailSyncService {
    private readonly logger = new Logger(MailSyncService.name);

    constructor(
        private readonly rls: RlsPrismaService,
        private readonly tokens: MailboxTokens,
        private readonly quota: GmailQuota,
        private readonly events: DomainEvents,
        @Inject(GMAIL_PORT) private readonly gmail: GmailPort,
    ) {}

    /** One run for one mailbox. Throws on a failure worth retrying (the job is retried); records every outcome. */
    async syncMailbox(workspaceId: string, mailboxId: string, retry: RetryOptions = {}): Promise<SyncRunResult> {
        const skipped: SyncRunResult = { mode: 'skipped', imported: 0, duplicates: 0, skippedByLabel: 0, blocked: 0 };
        const mailbox = await this.rls.withWorkspace(workspaceId, (tx) =>
            tx.mailbox.findUnique({ where: { id: mailboxId } }),
        );
        if (!mailbox) return skipped;
        if (mailbox.status !== 'connected') {
            await this.recordStopped(mailbox, unavailableError(mailbox.status));
            return skipped;
        }

        const state = await this.rls.withWorkspace(workspaceId, (tx) =>
            tx.mailboxSyncState.upsert({
                where: { mailboxId },
                create: { mailboxId, workspaceId, status: 'syncing' },
                update: { status: 'syncing' },
            }),
        );
        const run = new Run(this, mailbox, retry);
        try {
            const result =
                state.fullSyncCompletedAt && state.historyId
                    ? await this.incremental(run, state.historyId, state.lastSyncedAt)
                    : await this.initial(run);
            await this.rls.withWorkspace(workspaceId, (tx) =>
                tx.mailboxSyncState.update({
                    where: { mailboxId },
                    data: {
                        status: 'idle',
                        historyId: run.historyId,
                        lastSyncedAt: new Date(),
                        lastError: Prisma.DbNull,
                        ...(result.mode === 'initial' ? { fullSyncCompletedAt: new Date() } : {}),
                    },
                }),
            );
            return result;
        } catch (error) {
            if (error instanceof MailboxUnavailable) {
                await this.recordStopped(mailbox, unavailableError(error.mailboxStatus));
                return skipped;
            }
            await this.recordStopped(mailbox, runError(error));
            throw error;
        }
    }

    // ── The three ways a run proceeds ────────────────────────────────────────────────────────

    private async initial(run: Run): Promise<SyncRunResult> {
        const profile = await run.call(GMAIL_UNITS.getProfile, (token) => this.gmail.getProfile(token));
        const since = Date.now() - MAIL_INITIAL_SYNC_DAYS * 24 * 60 * 60 * 1000;
        const result = await this.importListed(run, since);
        run.historyId = profile.historyId;
        return { ...result, mode: 'initial' };
    }

    private async incremental(run: Run, startHistoryId: string, lastSyncedAt: Date | null): Promise<SyncRunResult> {
        try {
            const ids: string[] = [];
            let pageToken: string | undefined;
            let historyId = startHistoryId;
            do {
                const page = await run.call(GMAIL_UNITS.listHistory, (token) =>
                    this.gmail
                        .listHistory(token, { startHistoryId, ...(pageToken ? { pageToken } : {}) })
                        .catch((error: unknown) => {
                            if (error instanceof GmailApiError && error.status === 404) throw new HistoryExpired();
                            throw error;
                        }),
                );
                ids.push(...page.addedMessageIds);
                historyId = page.historyId || historyId;
                pageToken = page.nextPageToken ?? undefined;
            } while (pageToken);
            const result = await this.importIds(run, [...new Set(ids)]);
            run.historyId = historyId;
            return { ...result, mode: 'incremental' };
        } catch (error) {
            if (!(error instanceof HistoryExpired)) throw error;
            // Gmail no longer keeps history that old: re-list from the last good sync (less a
            // margin), never further back than the first import reached, and start a new cursor.
            const profile = await run.call(GMAIL_UNITS.getProfile, (token) => this.gmail.getProfile(token));
            const floor = Date.now() - MAIL_INITIAL_SYNC_DAYS * 24 * 60 * 60 * 1000;
            const since = Math.max(floor, (lastSyncedAt?.getTime() ?? floor) - MAIL_RESYNC_MARGIN_MS);
            const result = await this.importListed(run, since);
            run.historyId = profile.historyId;
            this.logger.warn(
                `mailbox ${run.mailbox.id}: history cursor expired; re-listed since ${new Date(since).toISOString()}`,
            );
            return { ...result, mode: 'recovered' };
        }
    }

    /** Lists every message since `sinceMs` and imports the ones not stored yet. */
    private async importListed(run: Run, sinceMs: number): Promise<Omit<SyncRunResult, 'mode'>> {
        const query = `after:${Math.floor(sinceMs / 1000)}`;
        const ids: string[] = [];
        let pageToken: string | undefined;
        do {
            const page = await run.call(GMAIL_UNITS.listMessages, (token) =>
                this.gmail.listMessages(token, { query, ...(pageToken ? { pageToken } : {}) }),
            );
            ids.push(...page.messages.map((m) => m.id));
            pageToken = page.nextPageToken ?? undefined;
        } while (pageToken);
        return this.importIds(run, [...new Set(ids)]);
    }

    /**
     * Fetches and stores the given message ids. Fetching is concurrent within a chunk; writing is
     * sequential and oldest first, so a thread's first message is the first stored and no two
     * writes of one run race each other.
     */
    private async importIds(run: Run, ids: readonly string[]): Promise<Omit<SyncRunResult, 'mode'>> {
        const totals = { imported: 0, duplicates: 0, skippedByLabel: 0, blocked: 0 };
        const blocklist = await this.blocklistFor(run.mailbox);
        for (let start = 0; start < ids.length; start += GMAIL_LIST_PAGE_SIZE) {
            const chunk = ids.slice(start, start + GMAIL_LIST_PAGE_SIZE);
            const known = await this.knownIds(run.mailbox, chunk);
            const fresh = chunk.filter((id) => !known.has(id));
            totals.duplicates += chunk.length - fresh.length;
            const raws = await mapPool(fresh, GMAIL_FETCH_CONCURRENCY, (id) =>
                run.call(GMAIL_UNITS.getMessage, (token) => this.gmail.getMessage(token, id)),
            );
            const incoming: Incoming[] = [];
            for (const raw of raws) {
                const verdict = classify(run.mailbox, raw, blocklist);
                if (verdict === 'label') totals.skippedByLabel += 1;
                else if (verdict === 'blocked') totals.blocked += 1;
                else incoming.push(verdict);
            }
            incoming.sort((a, b) => a.parsed.sentAt.getTime() - b.parsed.sentAt.getTime());
            for (const message of incoming) {
                const stored = await this.store(run.mailbox, message);
                if (stored) {
                    totals.imported += 1;
                    this.events.publish(stored);
                } else {
                    totals.duplicates += 1;
                }
            }
        }
        return totals;
    }

    // ── Storing one message ──────────────────────────────────────────────────────────────────

    /** Stores the message, its thread and participants; returns the event to announce, or `null` if it was already stored. */
    private async store(mailbox: MailboxRow, message: Incoming): Promise<DomainEvent | null> {
        const { parsed, direction } = message;
        try {
            return await this.rls.withWorkspace(mailbox.workspaceId, async (tx) => {
                const thread = await tx.mailThread.upsert({
                    where: {
                        mailboxId_providerThreadId: {
                            mailboxId: mailbox.id,
                            providerThreadId: parsed.providerThreadId,
                        },
                    },
                    create: {
                        workspaceId: mailbox.workspaceId,
                        mailboxId: mailbox.id,
                        providerThreadId: parsed.providerThreadId,
                        subject: parsed.subject,
                        lastMessageAt: parsed.sentAt,
                    },
                    update: {},
                });
                const addresses = parsed.participants.map((p) => p.address);
                const [people, members] = await Promise.all([
                    personsByAddress(tx, addresses),
                    membersByAddress(tx, addresses),
                ]);
                const row = await tx.mailMessage.create({
                    data: {
                        workspaceId: mailbox.workspaceId,
                        mailboxId: mailbox.id,
                        threadId: thread.id,
                        providerMessageId: parsed.providerMessageId,
                        rfc822MessageId: parsed.rfc822MessageId,
                        inReplyTo: parsed.inReplyTo,
                        references: parsed.references,
                        direction,
                        fromAddress: parsed.from,
                        sentAt: parsed.sentAt,
                        snippet: parsed.snippet,
                        subject: parsed.subject,
                        bodyText: parsed.bodyText,
                        bodyHtmlSanitized: parsed.bodyHtml,
                        bodyTruncated: parsed.bodyTruncated,
                        hasAttachments: parsed.hasAttachments,
                        labelIds: parsed.labelIds,
                        participants: {
                            create: parsed.participants.map((p) => ({
                                workspaceId: mailbox.workspaceId,
                                role: p.role,
                                address: p.address,
                                displayName: p.displayName,
                                personId: people.get(p.address) ?? null,
                                memberId: members.get(p.address) ?? null,
                            })),
                        },
                    },
                });
                await recountThread(tx, thread.id);
                const targets = await recordTargetsForPeople(tx, [...people.values()]);
                const email: EmailSummary = {
                    messageId: row.id,
                    threadId: thread.id,
                    mailboxId: mailbox.id,
                    direction,
                    subject: parsed.subject,
                    snippet: parsed.snippet,
                    from: parsed.from,
                    sentAt: parsed.sentAt.toISOString(),
                    rfc822MessageId: parsed.rfc822MessageId,
                    inReplyTo: parsed.inReplyTo,
                    references: parsed.references,
                };
                const event: DomainEvent = {
                    type: direction === 'inbound' ? 'email.received' : 'email.sent',
                    object: 'email',
                    workspaceId: mailbox.workspaceId,
                    actor: { kind: 'sync', id: mailbox.id },
                    occurredAt: email.sentAt,
                    recordId: row.id,
                    targets,
                    email,
                };
                return event;
            });
        } catch (error) {
            // Another run stored it between our check and our write: it is stored, once.
            if (uniqueViolation(error)) return null;
            throw error;
        }
    }

    private async knownIds(mailbox: MailboxRow, ids: readonly string[]): Promise<Set<string>> {
        if (ids.length === 0) return new Set();
        const rows = await this.rls.withWorkspace(mailbox.workspaceId, (tx) =>
            tx.mailMessage.findMany({
                where: { mailboxId: mailbox.id, providerMessageId: { in: [...ids] } },
                select: { providerMessageId: true },
            }),
        );
        return new Set(rows.map((r) => r.providerMessageId));
    }

    /** The workspace's entries and the mailbox owner's own. */
    private async blocklistFor(mailbox: MailboxRow): Promise<string[]> {
        const rows = await this.rls.withWorkspace(mailbox.workspaceId, (tx) =>
            tx.blocklistEntry.findMany({
                where: { OR: [{ memberId: null }, { memberId: mailbox.ownerMemberId }] },
                select: { value: true },
            }),
        );
        return rows.map((r) => r.value);
    }

    // ── State ────────────────────────────────────────────────────────────────────────────────

    private async recordStopped(mailbox: MailboxRow, error: SyncErrorRecord): Promise<void> {
        const status: MailSyncStatus = 'failed';
        await this.rls.withWorkspace(mailbox.workspaceId, (tx) =>
            tx.mailboxSyncState.upsert({
                where: { mailboxId: mailbox.id },
                create: { mailboxId: mailbox.id, workspaceId: mailbox.workspaceId, status, lastError: error },
                update: { status, lastError: error },
            }),
        );
    }

    /** Used by `Run`: one Gmail request under the quota, with retries. */
    async gmailRequest<T>(
        mailbox: MailboxRow,
        units: number,
        retry: RetryOptions,
        request: (token: string) => Promise<T>,
    ): Promise<T> {
        return withGmailRetry(async () => {
            const token = await this.tokens.getAccessToken(mailbox.workspaceId, mailbox.id);
            await this.quota.take(mailbox.id, units);
            return request(token);
        }, retry);
    }
}

/** One run's context: the mailbox, the retry options, and the cursor it will leave. */
class Run {
    historyId: string | null = null;

    constructor(
        private readonly service: MailSyncService,
        readonly mailbox: MailboxRow,
        private readonly retry: RetryOptions,
    ) {}

    call<T>(units: number, request: (token: string) => Promise<T>): Promise<T> {
        return this.service.gmailRequest(this.mailbox, units, this.retry, request);
    }
}

/** Drafts, spam, trash and chats are passed over; so is mail every outside participant of which is blocklisted. */
function classify(
    mailbox: MailboxRow,
    raw: GmailRawMessage,
    blocklist: readonly string[],
): Incoming | 'label' | 'blocked' {
    const labels = raw.labelIds ?? [];
    if (labels.some((l) => (SKIPPED_LABELS as readonly string[]).includes(l))) return 'label';
    const parsed = parseGmailMessage(raw);
    const outside = [...new Set(parsed.participants.map((p) => p.address))].filter((a) => a !== mailbox.email);
    if (outside.length > 0 && outside.every((a) => blocklist.some((entry) => blocklistCovers(entry, a)))) {
        return 'blocked';
    }
    const direction = parsed.from === mailbox.email || labels.includes(SENT_LABEL) ? 'outbound' : 'inbound';
    return { parsed, direction };
}

/** A thread's count, last message and subject come from its rows after every write (one writer). */
async function recountThread(tx: WorkspaceClient, threadId: string): Promise<void> {
    await tx.$executeRaw`
        UPDATE mail_threads t SET
            message_count = s.count,
            last_message_at = s.last_at,
            subject = COALESCE(s.first_subject, t.subject),
            updated_at = now()
        FROM (
            SELECT count(*)::int AS count, max(sent_at) AS last_at,
                   (SELECT subject FROM mail_messages f WHERE f.thread_id = ${threadId}::uuid ORDER BY f.sent_at ASC, f.id ASC LIMIT 1) AS first_subject
            FROM mail_messages WHERE thread_id = ${threadId}::uuid
        ) s
        WHERE t.id = ${threadId}::uuid`;
}

/** `items` mapped with at most `concurrency` in flight; results in input order. */
async function mapPool<T, R>(items: readonly T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const results = new Array<R>(items.length);
    let next = 0;
    const worker = async (): Promise<void> => {
        while (next < items.length) {
            const index = next++;
            results[index] = await fn(items[index]!);
        }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
    return results;
}

function unavailableError(status: string): SyncErrorRecord {
    return {
        code: status === 'disconnected' ? 'mailbox_disconnected' : 'reconnect_needed',
        message:
            status === 'disconnected'
                ? 'the mailbox is disconnected; sync stopped'
                : 'the mailbox needs to be connected again; sync is paused until it is',
        at: new Date().toISOString(),
    };
}

function runError(error: unknown): SyncErrorRecord {
    const at = new Date().toISOString();
    if (error instanceof GmailApiError) {
        return {
            code: `gmail.${error.reason}`,
            message: `Gmail refused the sync (${error.status ?? 'no answer'})`,
            at,
        };
    }
    return { code: 'internal', message: 'the sync failed; it will be retried', at };
}

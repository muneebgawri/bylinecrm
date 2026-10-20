import { recordBounces } from '../sending-pool/bounces';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { DomainEvent, MailSyncStatus } from '@bylinecrm/shared';
import { Prisma } from '@prisma/client';
import { ReputationMonitor } from '../reputation/reputation-monitor';
import { DomainEvents } from '../events/domain-events.service';
import { uniqueViolation } from '../infra/prisma-errors';
import { RlsPrismaService, type WorkspaceClient } from '../infra/rls-prisma.service';
import { MailboxTokens, MailboxUnavailable } from '../mail-accounts/mailbox-tokens.service';
import { mapPool } from '../infra/map-pool';
import { GMAIL_PORT, GmailApiError, type GmailPort, type GmailRawMessage } from './gmail.port';
import {
    GMAIL_FETCH_CONCURRENCY,
    GMAIL_LIST_PAGE_SIZE,
    GMAIL_UNITS,
    MAIL_INITIAL_SYNC_DAYS,
    MAIL_RESYNC_MARGIN_MS,
    SENT_LABEL,
    SKIPPED_LABELS,
    STORE_ATTEMPTS,
} from './mail-sync.constants';
import { membersByAddress, personsByAddress, recordTargetsForPeople } from './matching';
import { parseGmailMessage, type ParsedMessage } from './parse-message';
import { entriesFor, everyOutsideBlocked } from './blocklist-rule';
import { GmailQuota } from './quota';
import { identityKeyOf, recountThread, threadOfReferenced } from './threads';
import { emailSummaryOf } from './summary';
import { linkOutbound, replyEventFor } from './replies';
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
    /** Listed by Gmail, gone by the time it was read (404): skipped, not a failure. */
    vanished: number;
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
 * transient failure with backoff. A message is stored once per workspace however many of its
 * mailboxes hold it (#107) — each mailbox's copy recorded beside it — its participants matched to
 * people and members, and announced as `email.received` / `email.sent` on the records it concerns
 * when it first arrives — which is what puts it on their timelines, exactly once.
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
        private readonly reputation: ReputationMonitor,
    ) {}

    /** One run for one mailbox. Throws on a failure worth retrying (the job is retried); records every outcome. */
    async syncMailbox(workspaceId: string, mailboxId: string, retry: RetryOptions = {}): Promise<SyncRunResult> {
        const skipped: SyncRunResult = {
            mode: 'skipped',
            imported: 0,
            duplicates: 0,
            skippedByLabel: 0,
            blocked: 0,
            vanished: 0,
        };
        const mailbox = await this.rls.withWorkspace(workspaceId, (tx) =>
            tx.mailbox.findUnique({ where: { id: mailboxId } }),
        );
        // An SMTP2Go mailbox (TRANS-1) has no Gmail to read; what it sends is stored by `storeSent`.
        if (!mailbox || mailbox.transport !== 'gmail') return skipped;
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
            // REP-1: what left this mailbox, however it was sent, judged against the reputation rules (never throws).
            await this.reputation.afterSync(workspaceId, mailboxId);
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

    /**
     * Imports one message the mailbox holds, by Gmail's id, through the same path as a sync (P2-3:
     * the send job stores what it sent this way). Returns the stored message's id, or `null` when
     * the message is passed over (a label, or the blocklist). Already stored is not an error: its
     * id is returned and nothing is announced again.
     */
    async importMessage(
        workspaceId: string,
        mailboxId: string,
        providerMessageId: string,
        retry: RetryOptions = {},
    ): Promise<string | null> {
        const mailbox = await this.rls.withWorkspace(workspaceId, (tx) =>
            tx.mailbox.findUnique({ where: { id: mailboxId } }),
        );
        if (!mailbox) return null;
        await this.importIds(new Run(this, mailbox, retry), [providerMessageId]);
        const copy = await this.rls.withWorkspace(workspaceId, (tx) =>
            tx.mailMessageCopy.findUnique({
                where: { mailboxId_providerMessageId: { mailboxId, providerMessageId } },
                select: { messageId: true },
            }),
        );
        return copy?.messageId ?? null;
    }

    /**
     * Stores a message the mailbox sent through another transport (TRANS-1: SMTP2Go), in Gmail's message shape,
     * through the same one writer as a sync — so it is linked to its send, threaded with what it answers, on the
     * timeline as `email.sent` (which moves a sequence on), and a reply to it is recognised by its Message-ID as
     * any other. Returns the stored message's id; already stored is not an error.
     */
    async storeSent(workspaceId: string, mailboxId: string, message: GmailRawMessage): Promise<string | null> {
        const mailbox = await this.rls.withWorkspace(workspaceId, (tx) =>
            tx.mailbox.findUnique({ where: { id: mailboxId } }),
        );
        if (!mailbox) return null;
        await this.store(mailbox, { parsed: parseGmailMessage(message), direction: 'outbound' });
        const copy = await this.rls.withWorkspace(workspaceId, (tx) =>
            tx.mailMessageCopy.findUnique({
                where: { mailboxId_providerMessageId: { mailboxId, providerMessageId: message.id } },
                select: { messageId: true },
            }),
        );
        return copy?.messageId ?? null;
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
        const totals = { imported: 0, duplicates: 0, skippedByLabel: 0, blocked: 0, vanished: 0 };
        const blocklist = await this.blocklistFor(run.mailbox);
        for (let start = 0; start < ids.length; start += GMAIL_LIST_PAGE_SIZE) {
            const chunk = ids.slice(start, start + GMAIL_LIST_PAGE_SIZE);
            const known = await this.knownIds(run.mailbox, chunk);
            const fresh = chunk.filter((id) => !known.has(id));
            totals.duplicates += chunk.length - fresh.length;
            // A message listed a moment ago and gone by the time it is read (a deleted draft, a message
            // emptied from Trash) answers 404: it no longer exists, so it is skipped, never a failed run.
            const fetched = await mapPool(fresh, GMAIL_FETCH_CONCURRENCY, (id) =>
                run
                    .call(GMAIL_UNITS.getMessage, (token) => this.gmail.getMessage(token, id))
                    .catch((error: unknown) => {
                        if (error instanceof GmailApiError && error.status === 404) return null;
                        throw error;
                    }),
            );
            const raws = fetched.filter((raw): raw is NonNullable<typeof raw> => raw !== null);
            totals.vanished += fetched.length - raws.length;
            const incoming: Incoming[] = [];
            for (const raw of raws) {
                const verdict = classify(run.mailbox, raw, blocklist);
                if (verdict === 'label') totals.skippedByLabel += 1;
                else if (verdict === 'blocked') totals.blocked += 1;
                else incoming.push(verdict);
            }
            incoming.sort((a, b) => a.parsed.sentAt.getTime() - b.parsed.sentAt.getTime());
            for (const message of incoming) {
                if (await this.store(run.mailbox, message)) totals.imported += 1;
                else totals.duplicates += 1;
            }
        }
        return totals;
    }

    // ── Storing one message ──────────────────────────────────────────────────────────────────

    /**
     * Stores one mailbox's copy of a message (#107). The message itself is stored once per
     * workspace, keyed by its RFC 822 Message-ID: the first copy of it writes the message, its
     * thread, its participants and its events in one transaction (P1-6) — its `email.received` /
     * `email.sent`, then an `email.replied` when it answers one of our sends (P2-3). A later copy, in
     * another mailbox, records only that the mailbox holds it: nothing is announced again. An
     * outbound copy that is one of our sends is linked to it, whichever copy came first. Returns
     * false when this copy was already stored. One writer: the send job's import and every sync come
     * through here.
     */
    private async store(mailbox: MailboxRow, message: Incoming): Promise<boolean> {
        // Two mailboxes' runs may store the first copy of one message at once: the loser of the race
        // finds the message on its second attempt and stores its copy.
        for (let attempt = 1; ; attempt += 1) {
            try {
                return await this.rls.withWorkspace(mailbox.workspaceId, (tx) => this.write(tx, mailbox, message));
            } catch (error) {
                if (!uniqueViolation(error)) throw error;
                if (attempt === STORE_ATTEMPTS) return false;
            }
        }
    }

    private async write(tx: WorkspaceClient, mailbox: MailboxRow, message: Incoming): Promise<boolean> {
        const { parsed, direction } = message;
        const copied = await tx.mailMessageCopy.findUnique({
            where: {
                mailboxId_providerMessageId: { mailboxId: mailbox.id, providerMessageId: parsed.providerMessageId },
            },
            select: { id: true },
        });
        if (copied) return false;
        const identityKey = identityKeyOf(mailbox.id, parsed);
        const [existing, mapped] = await Promise.all([
            tx.mailMessage.findUnique({
                where: { workspaceId_identityKey: { workspaceId: mailbox.workspaceId, identityKey } },
                select: { id: true, threadId: true, rfc822MessageId: true },
            }),
            tx.mailboxThread.findUnique({
                where: {
                    mailboxId_providerThreadId: { mailboxId: mailbox.id, providerThreadId: parsed.providerThreadId },
                },
                select: { id: true, threadId: true },
            }),
        ]);
        const copy = (messageId: string, mailboxThreadId: string) => ({
            workspaceId: mailbox.workspaceId,
            messageId,
            mailboxId: mailbox.id,
            mailboxThreadId,
            providerMessageId: parsed.providerMessageId,
            direction,
            labelIds: parsed.labelIds,
        });
        const linkSend = (messageId: string, rfc822MessageId: string | null) =>
            linkOutbound(tx, mailbox, {
                id: messageId,
                rfc822MessageId,
                providerMessageId: parsed.providerMessageId,
                providerThreadId: parsed.providerThreadId,
                crmId: parsed.crmId,
            });

        if (existing) {
            // Another mailbox stored it first: this mailbox holds a copy, and its Gmail thread is
            // the message's conversation unless the mailbox already threads it elsewhere.
            const mailboxThreadId = mapped?.id ?? (await this.mapThread(tx, mailbox, parsed, existing.threadId));
            await tx.mailMessageCopy.create({ data: copy(existing.id, mailboxThreadId) });
            if (direction === 'outbound') await linkSend(existing.id, existing.rfc822MessageId);
            return true;
        }

        const threadId =
            mapped?.threadId ??
            (await threadOfReferenced(tx, parsed)) ??
            (
                await tx.mailThread.create({
                    data: { workspaceId: mailbox.workspaceId, subject: parsed.subject, lastMessageAt: parsed.sentAt },
                    select: { id: true },
                })
            ).id;
        const mailboxThreadId = mapped?.id ?? (await this.mapThread(tx, mailbox, parsed, threadId));
        const addresses = parsed.participants.map((p) => p.address);
        const [people, members, sentFromWorkspace] = await Promise.all([
            personsByAddress(tx, addresses),
            membersByAddress(tx, addresses),
            direction === 'outbound'
                ? Promise.resolve(true)
                : tx.mailbox.count({ where: { email: parsed.from } }).then((n) => n > 0),
        ]);
        const row = await tx.mailMessage.create({
            data: {
                workspaceId: mailbox.workspaceId,
                threadId,
                identityKey,
                rfc822MessageId: parsed.rfc822MessageId,
                inReplyTo: parsed.inReplyTo,
                references: parsed.references,
                // The workspace's view: sent when it left one of the workspace's own mailboxes.
                direction: sentFromWorkspace ? 'outbound' : 'inbound',
                fromAddress: parsed.from,
                sentAt: parsed.sentAt,
                snippet: parsed.snippet,
                subject: parsed.subject,
                bodyText: parsed.bodyText,
                bodyHtmlSanitized: parsed.bodyHtml,
                bodyTruncated: parsed.bodyTruncated,
                hasAttachments: parsed.hasAttachments,
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
        await tx.mailMessageCopy.create({ data: copy(row.id, mailboxThreadId) });
        await recountThread(tx, threadId);
        const targets = await recordTargetsForPeople(tx, [...people.values()]);
        const email = emailSummaryOf(row, mailbox.id);
        const event: DomainEvent = {
            type: row.direction === 'inbound' ? 'email.received' : 'email.sent',
            object: 'email',
            workspaceId: mailbox.workspaceId,
            actor: { kind: 'sync', id: mailbox.id },
            occurredAt: email.sentAt,
            recordId: row.id,
            targets,
            email,
        };
        if (direction === 'outbound') await linkSend(row.id, row.rfc822MessageId);
        const fromPeople = parsed.participants
            .filter((p) => p.role === 'from')
            .map((p) => people.get(p.address))
            .filter((id): id is string => id !== undefined);
        const replied = await replyEventFor(
            tx,
            mailbox,
            {
                id: row.id,
                threadId,
                from: row.fromAddress,
                inReplyTo: row.inReplyTo,
                references: row.references,
                sentAt: row.sentAt,
            },
            email,
            fromPeople,
        );
        // A bounce report a pool mailbox received is recorded with it (P3-2).
        const bounced =
            mailbox.purpose === 'pool' && parsed.bounce
                ? await recordBounces(tx, mailbox, { id: row.id, sentAt: row.sentAt }, parsed.bounce)
                : [];
        await this.events.recordAll(tx, [event, ...(replied ? [replied] : []), ...bounced]);
        return true;
    }

    /** Records that the mailbox's Gmail thread is part of `threadId`; returns the mapping's id. */
    private async mapThread(
        tx: WorkspaceClient,
        mailbox: MailboxRow,
        parsed: ParsedMessage,
        threadId: string,
    ): Promise<string> {
        const row = await tx.mailboxThread.create({
            data: {
                workspaceId: mailbox.workspaceId,
                mailboxId: mailbox.id,
                providerThreadId: parsed.providerThreadId,
                threadId,
            },
            select: { id: true },
        });
        return row.id;
    }

    private async knownIds(mailbox: MailboxRow, ids: readonly string[]): Promise<Set<string>> {
        if (ids.length === 0) return new Set();
        const rows = await this.rls.withWorkspace(mailbox.workspaceId, (tx) =>
            tx.mailMessageCopy.findMany({
                where: { mailboxId: mailbox.id, providerMessageId: { in: [...ids] } },
                select: { providerMessageId: true },
            }),
        );
        return new Set(rows.map((r) => r.providerMessageId));
    }

    /** The entries that apply to this mailbox (`entriesFor`: the workspace's, and its owner's own on a personal mailbox). */
    private async blocklistFor(mailbox: MailboxRow): Promise<string[]> {
        const rows = await this.rls.withWorkspace(mailbox.workspaceId, (tx) =>
            tx.blocklistEntry.findMany({
                where: { OR: [{ memberId: null }, { memberId: mailbox.ownerMemberId }] },
                select: { value: true, memberId: true },
            }),
        );
        return entriesFor(mailbox, rows);
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

    /**
     * Counts `units` against the mailbox's per-second quota (waiting if the window is full), for a
     * caller already holding a token from `gmailRequest` that makes further requests of its own —
     * sending's lookup of a send whose answer was lost (P2-3a).
     */
    async chargeQuota(mailboxId: string, units: number): Promise<void> {
        await this.quota.take(mailboxId, units);
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
    if (
        everyOutsideBlocked(
            mailbox.email,
            parsed.participants.map((p) => p.address),
            blocklist,
        )
    )
        return 'blocked';
    const direction = parsed.from === mailbox.email || labels.includes(SENT_LABEL) ? 'outbound' : 'inbound';
    return { parsed, direction };
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

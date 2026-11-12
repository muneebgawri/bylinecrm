import { recordBounces } from '../sending-pool/bounces';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { DomainEvent, MailSyncStatus } from '@bylinecrm/shared';
import { Prisma } from '@prisma/client';
import { ReputationMonitor } from '../reputation/reputation-monitor';
import { DomainEvents } from '../events/domain-events.service';
import { uniqueViolation } from '../infra/prisma-errors';
import { RlsPrismaService, type WorkspaceClient } from '../infra/rls-prisma.service';
import { PrismaService } from '../infra/prisma.service';
import { ENV, type Env } from '../config/env';
import { DelegationService } from '../mail-accounts/delegation.service';
import { MailboxTokens, MailboxUnavailable } from '../mail-accounts/mailbox-tokens.service';
import { mapPool } from '../infra/map-pool';
import { GMAIL_PORT, GmailApiError, type GmailPort, type GmailRawMessage } from './gmail.port';
import {
    GMAIL_FETCH_CONCURRENCY,
    GMAIL_LIST_PAGE_SIZE,
    GMAIL_UNITS,
    MAIL_BACKFILL_LEASE_MS,
    MAIL_BACKFILL_REFRESH_BATCH,
    MAIL_BACKFILL_METADATA_HEADERS,
    MAIL_INITIAL_SYNC_DAYS,
    MAIL_RESYNC_MARGIN_MS,
    SENT_LABEL,
    SKIPPED_LABELS,
    STORE_ATTEMPTS,
} from './mail-sync.constants';
import {
    heldOnlyByServiceInboxes,
    membersByAddress,
    personsByAddress,
    recordTargetsForPeople,
    rematchMessage,
} from './matching';
import { reconcileMessageTargets } from './reconcile';
import { parseGmailMessage, participantsOf, type ParsedMessage } from './parse-message';
import {
    addProgress,
    concernsPerson,
    emptyProgress,
    nextWindow,
    progressOf,
    storedBytesOf,
    windowQuery,
    type BackfillProgress,
    type BackfillStatus,
    type BackfillWindow,
} from './history-backfill';
import { entriesFor, everyOutsideBlocked } from './blocklist-rule';
import { GmailQuota } from './quota';
import { identityKeyOf, recountThread, threadOfReferenced } from './threads';
import { refreshContactStatus } from '../customers/contact-status.service';
import { emailSummaryOf } from './summary';
import { linkOutbound, replyEventFor } from './replies';
import { rateLimitedRuns, withGmailRetry, type RateLimitRecord, type RetryOptions } from './retry';

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
    /** Consecutive runs that ended rate-limited, this one included (`rateLimitedRuns`); absent for any other failure. */
    rateLimitedRuns?: number;
    /** When Gmail said it would take requests again (ISO 8601) — the cool-down holds until then (PNW-1125). */
    retryAfter?: string;
};

/** How much of Google's message a stored error keeps: enough to name the limit and the time, never a page of it. */
const GOOGLE_MESSAGE_MAX = 300;

/** Thrown inside a run when Gmail no longer has history after the stored cursor. */
class HistoryExpired extends Error {}

/** A message ready to store: parsed, classified, and confirmed not blocklisted. */
interface Incoming {
    parsed: ParsedMessage;
    direction: 'inbound' | 'outbound';
    /** Stored by the history backfill: its events say so (`EmailSummary.historical`). */
    historical?: boolean;
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
        private readonly delegation: DelegationService,
        private readonly quota: GmailQuota,
        private readonly events: DomainEvents,
        @Inject(GMAIL_PORT) private readonly gmail: GmailPort,
        private readonly reputation: ReputationMonitor,
        /** The owner connection: only for the backfill's workspace-wide budget and the database's own sizes. */
        private readonly owner: PrismaService,
        @Inject(ENV) private readonly env: Env,
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
        // #225: every delegated sync start is audited.
        if (mailbox) await this.delegation.noteSyncStart(mailbox, 'mail');
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
            const record = runError(error);
            // A refusal is logged with Google's own words, so the reason survives a restart and can be searched.
            if (error instanceof GmailApiError) {
                const until = record.retryAfter ? `; Gmail says retry after ${record.retryAfter}` : '';
                this.logger.warn(`mailbox ${mailbox.id}: ${record.code} — ${record.message}${until}`);
            }
            await this.recordStopped(mailbox, record);
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
            const deleted = new Set<string>();
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
                for (const id of page.deletedMessageIds) deleted.add(id);
                historyId = page.historyId || historyId;
                pageToken = page.nextPageToken ?? undefined;
            } while (pageToken);
            // A message added and then permanently deleted since the cursor (a draft replaced by its next
            // save) would only answer 404 — at a full read's cost — so it is never read (PNW-1192).
            const result = await this.importIds(
                run,
                [...new Set(ids)].filter((id) => !deleted.has(id)),
            );
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
            await this.fetchAndStore(run, fresh, blocklist, totals);
        }
        return totals;
    }

    /**
     * Reads the given messages whole and stores each that is not passed over (one writer, `store`), oldest first;
     * adds what happened to `totals`. `stored` hears of each message stored.
     */
    private async fetchAndStore(
        run: Run,
        ids: readonly string[],
        blocklist: readonly string[],
        totals: Omit<SyncRunResult, 'mode'>,
        stored: (parsed: ParsedMessage) => void = () => undefined,
        historical = false,
    ): Promise<void> {
        // A message listed a moment ago and gone by the time it is read (a deleted draft, a message
        // emptied from Trash) answers 404: it no longer exists, so it is skipped, never a failed run.
        const fetched = await mapPool(ids, GMAIL_FETCH_CONCURRENCY, (id) =>
            run.call(GMAIL_UNITS.getMessage, (token) => this.gmail.getMessage(token, id)).catch(nullOn404),
        );
        const raws = fetched.filter((raw): raw is NonNullable<typeof raw> => raw !== null);
        totals.vanished += fetched.length - raws.length;
        const incoming: Incoming[] = [];
        for (const raw of raws) {
            const verdict = classify(run.mailbox, raw, blocklist);
            if (verdict === 'label') totals.skippedByLabel += 1;
            else if (verdict === 'blocked') totals.blocked += 1;
            else incoming.push(historical ? { ...verdict, historical: true } : verdict);
        }
        incoming.sort((a, b) => a.parsed.sentAt.getTime() - b.parsed.sentAt.getTime());
        for (const message of incoming) {
            if (await this.store(run.mailbox, message)) {
                totals.imported += 1;
                stored(message.parsed);
            } else totals.duplicates += 1;
        }
    }

    // ── The history backfill ─────────────────────────────────────────────────────────────────
    //
    // The same sync reaching further back: a mailbox's history floor, walked down to a window (a month) per step,
    // newest first, from where the first import began. Each window is listed, what the mailbox already holds is
    // skipped, the rest read as headers only, and only a message one of whose participants is a person of the
    // workspace is read whole and stored — through `store`, so it lands on the timelines and counts toward contact
    // status like any synced mail. The cursor moves only once a window is done, so a step cut short (a deploy, a
    // throttled Gmail, the budget) repeats its window and what it stored is skipped as already held.

    /**
     * Sets the mailbox's history floor and starts its backfill (or resumes one stopped at the budget). A floor below
     * the one set walks on further; one at or above it changes nothing. Returns false for a mailbox with no history
     * to bring onto the records: not a connected Gmail mailbox, or a service inbox (its mail is on no record).
     */
    async startBackfill(workspaceId: string, mailboxId: string, floor: Date): Promise<boolean> {
        const mailbox = await this.rls.withWorkspace(workspaceId, (tx) =>
            tx.mailbox.findUnique({ where: { id: mailboxId } }),
        );
        if (!mailbox || !backfillable(mailbox)) return false;
        await this.rls.withWorkspace(workspaceId, async (tx) => {
            const state = await tx.mailboxSyncState.findUnique({
                where: { mailboxId },
                select: { historyFloor: true, backfillStatus: true },
            });
            const lower = !state?.historyFloor || floor.getTime() < state.historyFloor.getTime();
            if (!lower && state?.backfillStatus === 'done') return;
            const status: BackfillStatus = 'running';
            await tx.mailboxSyncState.upsert({
                where: { mailboxId },
                create: { mailboxId, workspaceId, historyFloor: floor, backfillStatus: status },
                update: {
                    ...(lower ? { historyFloor: floor } : {}),
                    backfillStatus: status,
                    backfillCompletedAt: null,
                },
            });
        });
        return true;
    }

    /**
     * One step of the mailbox's backfill: the next window below its cursor. `walked`: a window done, more may follow;
     * `done`: the floor is reached; `budget_reached`: the workspace-wide byte budget is spent (the step stops where it
     * is, and nothing walks on until the backfill is started again); `busy`: another process holds the mailbox's
     * step; `waiting`: the mailbox's first import has not finished; `idle`: no backfill is running for it.
     */
    async backfillStep(workspaceId: string, mailboxId: string, retry: RetryOptions = {}): Promise<BackfillStepResult> {
        const nothing = (outcome: BackfillStepResult['outcome']): BackfillStepResult => ({
            outcome,
            window: null,
            progress: emptyProgress(),
        });
        const mailbox = await this.rls.withWorkspace(workspaceId, (tx) =>
            tx.mailbox.findUnique({ where: { id: mailboxId } }),
        );
        if (!mailbox || !backfillable(mailbox)) return nothing('idle');
        const state = await this.claimBackfill(mailbox);
        if (state === 'idle' || state === 'busy') return nothing(state);
        try {
            if (!state.fullSyncCompletedAt) return nothing('waiting');
            if (await this.backfillBudgetSpent()) {
                await this.finishBackfill(mailbox, 'budget_reached');
                return nothing('budget_reached');
            }
            const window = nextWindow(backfillCursor(state), state.historyFloor!);
            if (!window) {
                await this.finishBackfill(mailbox, 'done');
                return nothing('done');
            }
            await this.delegation.noteSyncStart(mailbox, 'mail');
            const progress = await this.walkWindow(new Run(this, mailbox, retry), window, {
                kind: 'store',
                chunkDone: async (delta, bytes) => {
                    await this.rls.withWorkspace(workspaceId, async (tx) => {
                        const now = await tx.mailboxSyncState.findUnique({
                            where: { mailboxId },
                            select: { backfillProgress: true },
                        });
                        await tx.mailboxSyncState.update({
                            where: { mailboxId },
                            data: {
                                backfillProgress: { ...addProgress(progressOf(now?.backfillProgress), delta) },
                                backfillBytes: { increment: bytes },
                                backfillLeaseUntil: new Date(Date.now() + MAIL_BACKFILL_LEASE_MS),
                            },
                        });
                    });
                    return this.backfillBudgetSpent();
                },
            });
            if (progress === 'budget_reached') {
                await this.finishBackfill(mailbox, 'budget_reached');
                return nothing('budget_reached');
            }
            const reached = window.after.getTime() <= state.historyFloor!.getTime();
            await this.rls.withWorkspace(workspaceId, async (tx) => {
                const now = await tx.mailboxSyncState.findUnique({
                    where: { mailboxId },
                    select: { backfillProgress: true },
                });
                await tx.mailboxSyncState.update({
                    where: { mailboxId },
                    data: {
                        backfillBefore: window.after,
                        backfillProgress: { ...addProgress(progressOf(now?.backfillProgress), { windows: 1 }) },
                        ...(reached ? { backfillStatus: 'done', backfillCompletedAt: new Date() } : {}),
                    },
                });
            });
            return { outcome: reached ? 'done' : 'walked', window, progress: { ...progress, windows: 1 } };
        } finally {
            await this.rls.withWorkspace(workspaceId, (tx) =>
                tx.mailboxSyncState.update({ where: { mailboxId }, data: { backfillLeaseUntil: null } }),
            );
        }
    }

    /**
     * What a backfill of the mailbox down to `floor` would do — stores nothing, writes nothing: every window is listed,
     * what the mailbox already holds counted, and the rest read as headers only (at most `sample` per window, the
     * share that concerns a person then applied to the window) to count the messages that would be stored. Their
     * size is projected by the caller from the database's average stored message (`averageStoredMessageBytes`).
     */
    async estimateBackfill(
        workspaceId: string,
        mailboxId: string,
        floor: Date,
        options: { sample?: number | undefined; retry?: RetryOptions } = {},
    ): Promise<BackfillEstimate | null> {
        const [mailbox, state] = await this.rls.withWorkspace(workspaceId, (tx) =>
            Promise.all([
                tx.mailbox.findUnique({ where: { id: mailboxId } }),
                tx.mailboxSyncState.findUnique({ where: { mailboxId } }),
            ]),
        );
        if (!mailbox || !backfillable(mailbox) || !state?.fullSyncCompletedAt) return null;
        const run = new Run(this, mailbox, options.retry ?? {});
        const estimate: BackfillEstimate = {
            mailboxId,
            email: mailbox.email,
            from: backfillCursor(state),
            windows: 0,
            listed: 0,
            alreadyStored: 0,
            headersRead: 0,
            matched: 0,
            wouldStore: 0,
        };
        let window = nextWindow(estimate.from, floor);
        while (window) {
            const counted = await this.walkWindow(run, window, { kind: 'estimate', sample: options.sample });
            if (counted === 'budget_reached') break; // never: an estimate has no budget
            estimate.windows += 1;
            estimate.listed += counted.listed;
            estimate.alreadyStored += counted.alreadyStored;
            estimate.headersRead += counted.headersRead;
            estimate.matched += counted.matched;
            estimate.wouldStore += counted.wouldStore;
            window = nextWindow(window.after, floor);
        }
        return estimate;
    }

    /** What the backfill has stored so far, over every mailbox of every workspace, and its budget. */
    async backfillBudget(): Promise<{ usedBytes: number; maxBytes: number }> {
        const sum = await this.owner.mailboxSyncState.aggregate({ _sum: { backfillBytes: true } });
        return { usedBytes: Number(sum._sum.backfillBytes ?? 0n), maxBytes: this.env.MAIL_BACKFILL_MAX_BYTES };
    }

    /** The database's mail tables (rows, TOAST and indexes) per stored message: what an estimate projects with. */
    async averageStoredMessageBytes(): Promise<number> {
        const [row] = await this.owner.$queryRaw<{ bytes: bigint; messages: bigint }[]>`
            SELECT (pg_total_relation_size('mail_messages') + pg_total_relation_size('mail_participants')
                    + pg_total_relation_size('mail_message_copies') + pg_total_relation_size('mail_threads')
                    + pg_total_relation_size('mailbox_threads'))::bigint AS bytes,
                   (SELECT count(*) FROM mail_messages)::bigint AS messages`;
        const messages = Number(row?.messages ?? 0n);
        return messages === 0 ? 0 : Math.round(Number(row!.bytes) / messages);
    }

    private async backfillBudgetSpent(): Promise<boolean> {
        const { usedBytes, maxBytes } = await this.backfillBudget();
        return usedBytes >= maxBytes;
    }

    /**
     * Takes the mailbox's backfill step for this process (`MAIL_BACKFILL_LEASE_MS`, renewed per chunk): one atomic
     * update, so the CLI and the worker never walk one mailbox at once. `idle` when no backfill is running for it.
     */
    private async claimBackfill(
        mailbox: MailboxRow,
    ): Promise<Prisma.MailboxSyncStateGetPayload<object> | 'idle' | 'busy'> {
        return this.rls.withWorkspace(mailbox.workspaceId, async (tx) => {
            const now = new Date();
            const claimed = await tx.mailboxSyncState.updateMany({
                where: {
                    mailboxId: mailbox.id,
                    backfillStatus: 'running',
                    historyFloor: { not: null },
                    OR: [{ backfillLeaseUntil: null }, { backfillLeaseUntil: { lt: now } }],
                },
                data: { backfillLeaseUntil: new Date(now.getTime() + MAIL_BACKFILL_LEASE_MS) },
            });
            const state = await tx.mailboxSyncState.findUnique({ where: { mailboxId: mailbox.id } });
            if (claimed.count === 1 && state) return state;
            return state?.backfillStatus === 'running' && state.historyFloor ? 'busy' : 'idle';
        });
    }

    private async finishBackfill(mailbox: MailboxRow, status: Exclude<BackfillStatus, 'running'>): Promise<void> {
        await this.rls.withWorkspace(mailbox.workspaceId, (tx) =>
            tx.mailboxSyncState.update({
                where: { mailboxId: mailbox.id },
                data: { backfillStatus: status, ...(status === 'done' ? { backfillCompletedAt: new Date() } : {}) },
            }),
        );
        if (status === 'budget_reached') {
            this.logger.warn(`mailbox ${mailbox.id}: mail history backfill stopped at MAIL_BACKFILL_MAX_BYTES`);
        }
    }

    /**
     * Lists one window and goes through it a chunk at a time: what the mailbox holds is skipped unread, the rest is
     * read as headers only, and what concerns a person is stored (`store`) or counted (`estimate`). A store walk calls
     * `chunkDone` after each chunk with what it did; its answer `true` (the budget is spent) stops the walk.
     */
    private async walkWindow(
        run: Run,
        window: BackfillWindow,
        mode:
            | { kind: 'store'; chunkDone: (delta: BackfillProgress, bytes: number) => Promise<boolean> }
            | { kind: 'estimate'; sample?: number | undefined },
    ): Promise<WindowCounts | 'budget_reached'> {
        const query = windowQuery(window);
        const ids: string[] = [];
        let pageToken: string | undefined;
        do {
            const page = await run.call(GMAIL_UNITS.listMessages, (token) =>
                this.gmail.listMessages(token, { query, ...(pageToken ? { pageToken } : {}) }),
            );
            ids.push(...page.messages.map((m) => m.id));
            pageToken = page.nextPageToken ?? undefined;
        } while (pageToken);
        const unique = [...new Set(ids)];
        const counts: WindowCounts = {
            ...emptyProgress(),
            listed: unique.length,
            headersRead: 0,
            matched: 0,
            wouldStore: 0,
        };
        const blocklist = await this.blocklistFor(run.mailbox);
        let sampleLeft = mode.kind === 'estimate' ? (mode.sample ?? Infinity) : Infinity;
        // The addresses of everyone the window stored mail for: their contact status is re-derived once the window
        // is walked (or the budget stops it), not message by message — their events are flagged historical, and the
        // outbox fell hours behind re-deriving per message. A frequent correspondent appears in most chunks, and a
        // refresh reads all of a person's mail, so the window refreshes each person once,
        // `MAIL_BACKFILL_REFRESH_BATCH` people per transaction: no one transaction reads a crowd's mail.
        const addresses = new Set<string>();
        const refreshStored = async (): Promise<void> => {
            if (addresses.size === 0) return;
            const people = await this.rls.withWorkspace(run.mailbox.workspaceId, (tx) =>
                personsByAddress(tx, [...addresses]),
            );
            const ids = [...new Set(people.values())];
            for (let at = 0; at < ids.length; at += MAIL_BACKFILL_REFRESH_BATCH) {
                const batch = ids.slice(at, at + MAIL_BACKFILL_REFRESH_BATCH);
                await this.rls.withWorkspace(run.mailbox.workspaceId, (tx) => refreshContactStatus(tx, batch));
            }
        };
        for (let start = 0; start < unique.length; start += GMAIL_LIST_PAGE_SIZE) {
            const chunk = unique.slice(start, start + GMAIL_LIST_PAGE_SIZE);
            const known = await this.knownIds(run.mailbox, chunk);
            const fresh = chunk.filter((id) => !known.has(id));
            const delta = { ...emptyProgress(), alreadyStored: chunk.length - fresh.length };
            const read = fresh.slice(0, Math.min(fresh.length, sampleLeft));
            sampleLeft -= read.length;
            const matched = await this.matchingPeople(run, read, blocklist, delta);
            counts.headersRead += read.length;
            if (mode.kind === 'estimate') {
                counts.alreadyStored += delta.alreadyStored;
                counts.matched += matched.length;
                // Unread fresh messages (beyond the sample) are counted at the share the read ones matched at.
                const share = read.length === 0 ? 0 : matched.length / read.length;
                counts.wouldStore += matched.length + Math.round(share * (fresh.length - read.length));
                continue;
            }
            const totals = { imported: 0, duplicates: 0, skippedByLabel: 0, blocked: 0, vanished: 0 };
            let bytes = 0;
            await this.fetchAndStore(
                run,
                matched,
                blocklist,
                totals,
                (parsed) => {
                    bytes += storedBytesOf(parsed);
                    for (const p of parsed.participants) addresses.add(p.address);
                },
                true,
            );
            const done = addProgress(delta, totals);
            for (const key of Object.keys(done) as (keyof BackfillProgress)[]) counts[key] += done[key];
            counts.matched += matched.length;
            if (await mode.chunkDone(done, bytes)) {
                await refreshStored();
                return 'budget_reached';
            }
        }
        await refreshStored();
        return counts;
    }

    /**
     * Reads the messages' headers (`format=metadata`) and returns the ids of those that concern one of the
     * workspace's people (`concernsPerson`): never a draft, spam or trash, nor mail whose every outside participant is
     * blocklisted. What is passed over is counted in `delta`.
     */
    private async matchingPeople(
        run: Run,
        ids: readonly string[],
        blocklist: readonly string[],
        delta: BackfillProgress,
    ): Promise<string[]> {
        if (ids.length === 0) return [];
        const read = await mapPool(ids, GMAIL_FETCH_CONCURRENCY, (id) =>
            run
                .call(GMAIL_UNITS.getMessageMetadata, (token) =>
                    this.gmail.getMessageHeaders(token, id, MAIL_BACKFILL_METADATA_HEADERS),
                )
                .catch(nullOn404),
        );
        const candidates: { id: string; addresses: string[] }[] = [];
        for (const meta of read) {
            if (!meta) {
                delta.vanished += 1;
                continue;
            }
            if ((meta.labelIds ?? []).some((l) => (SKIPPED_LABELS as readonly string[]).includes(l))) {
                delta.skippedByLabel += 1;
                continue;
            }
            const addresses = participantsOf(meta.headers).map((p) => p.address);
            if (everyOutsideBlocked(run.mailbox.email, addresses, blocklist)) {
                delta.blocked += 1;
                continue;
            }
            candidates.push({ id: meta.id, addresses });
        }
        const all = [...new Set(candidates.flatMap((c) => c.addresses))];
        const [people, members] = await this.rls.withWorkspace(run.mailbox.workspaceId, (tx) =>
            Promise.all([personsByAddress(tx, all), membersByAddress(tx, all)]),
        );
        const matched = candidates.filter((c) => concernsPerson(c.addresses, run.mailbox.email, people, members));
        delta.unmatched += candidates.length - matched.length;
        return matched.map((c) => c.id);
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
            sentAt: parsed.sentAt,
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
            // SVC-1: mail only service inboxes held was on no record; a member's or a pool mailbox holding it puts
            // it on the records of the people it concerns, as if this copy had come first.
            const reaches = mailbox.purpose !== 'service' && (await heldOnlyByServiceInboxes(tx, existing.id));
            await tx.mailMessageCopy.create({ data: copy(existing.id, mailboxThreadId) });
            if (direction === 'outbound') await linkSend(existing.id, existing.rfc822MessageId);
            if (reaches) {
                const changed = await rematchMessage(tx, existing.id);
                await this.events.recordAll(tx, await reconcileMessageTargets(tx, mailbox.workspaceId, changed));
            }
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
        // SVC-1: a service inbox's mail is matched to no person, so it is on no record and replies to no send.
        const onRecords = mailbox.purpose !== 'service';
        const [people, members, sentFromWorkspace] = await Promise.all([
            onRecords ? personsByAddress(tx, addresses) : Promise.resolve(new Map<string, string>()),
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
        const email = emailSummaryOf(row, mailbox.id, message.historical === true);
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
        const replied = !onRecords
            ? null
            : await replyEventFor(
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
        await this.rls.withWorkspace(mailbox.workspaceId, async (tx) => {
            // A run that ends rate-limited counts on from the last one, which is what the tick's cool-down reads.
            const previous = await tx.mailboxSyncState.findUnique({
                where: { mailboxId: mailbox.id },
                select: { lastError: true },
            });
            const runs = rateLimitedRuns(error, (previous?.lastError ?? null) as RateLimitRecord | null);
            const lastError: SyncErrorRecord = runs ? { ...error, rateLimitedRuns: runs } : error;
            await tx.mailboxSyncState.upsert({
                where: { mailboxId: mailbox.id },
                create: { mailboxId: mailbox.id, workspaceId: mailbox.workspaceId, status, lastError },
                update: { status, lastError },
            });
        });
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

/** One backfill step's outcome (`MailSyncService.backfillStep`): the window it walked and what it did there. */
export interface BackfillStepResult {
    outcome: 'walked' | 'done' | 'budget_reached' | 'busy' | 'waiting' | 'idle';
    window: BackfillWindow | null;
    progress: BackfillProgress;
}

/** What a backfill of one mailbox would do (`MailSyncService.estimateBackfill`); nothing of it is stored. */
export interface BackfillEstimate {
    mailboxId: string;
    email: string;
    /** Where the walk would start: the mailbox's cursor, or where its first import began. */
    from: Date;
    windows: number;
    listed: number;
    alreadyStored: number;
    /** Messages read as headers only. */
    headersRead: number;
    /** Of those read, the ones that concern a person. */
    matched: number;
    /** Messages the backfill would store: those matched, and the unread ones at the share the read ones matched at. */
    wouldStore: number;
}

type WindowCounts = BackfillProgress & { headersRead: number; matched: number; wouldStore: number };

/** A mailbox whose history the backfill brings onto the records: a connected Gmail mailbox that is not a service inbox. */
function backfillable(mailbox: MailboxRow): boolean {
    return mailbox.transport === 'gmail' && mailbox.status === 'connected' && mailbox.purpose !== 'service';
}

/**
 * Where the backfill walks on from: its cursor, else where the first import began (`MAIL_INITIAL_SYNC_DAYS` before it
 * finished) plus a margin, so the boundary is listed twice rather than missed (a repeat is skipped unread).
 */
function backfillCursor(state: { backfillBefore: Date | null; fullSyncCompletedAt: Date | null }): Date {
    if (state.backfillBefore) return state.backfillBefore;
    const began = (state.fullSyncCompletedAt?.getTime() ?? Date.now()) - MAIL_INITIAL_SYNC_DAYS * 24 * 60 * 60 * 1000;
    return new Date(Math.min(Date.now(), began + MAIL_RESYNC_MARGIN_MS));
}

/** A message listed and gone by the time it is read answers 404: it is skipped, never a failed run. */
function nullOn404(error: unknown): null {
    if (error instanceof GmailApiError && error.status === 404) return null;
    throw error;
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

/**
 * What a failed run leaves on the mailbox. For a Gmail refusal: the reason, Google's own message (which limit, and until
 * when — dropped until PNW-1125, so four days of refusals on two inboxes said nothing) and the time Gmail named.
 */
export function runError(error: unknown): SyncErrorRecord {
    const at = new Date().toISOString();
    if (error instanceof GmailApiError) {
        const said = error.googleMessage ? `: ${error.googleMessage.slice(0, GOOGLE_MESSAGE_MAX)}` : '';
        return {
            code: `gmail.${error.reason}`,
            message: `Gmail refused the sync (${error.status ?? 'no answer'})${said}`,
            at,
            ...(error.retryAfter ? { retryAfter: error.retryAfter.toISOString() } : {}),
        };
    }
    return { code: 'internal', message: 'the sync failed; it will be retried', at };
}

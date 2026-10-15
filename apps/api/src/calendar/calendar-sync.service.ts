import { Inject, Injectable, Logger } from '@nestjs/common';
import { calendarGranted, GOOGLE_CALENDAR_SCOPE, type MailSyncStatus } from '@bylinecrm/shared';
import { Prisma } from '@prisma/client';
import { RlsPrismaService } from '../infra/rls-prisma.service';
import type { WorkspaceRunContext } from '../infra/workspace-context';
import { MailboxTokens, MailboxUnavailable } from '../mail-accounts/mailbox-tokens.service';
import { gmailRetryDelayMs, type RetryOptions } from '../mail-sync/retry';
import {
    CALENDAR_HORIZON_DAYS,
    CALENDAR_INITIAL_DAYS,
    CALENDAR_LEAD_SOURCE,
    CALENDAR_RECENT_DAYS,
    CALENDAR_RETRY_ATTEMPTS,
    CALENDAR_UPDATED_MARGIN_MS,
    CALENDAR_WINDOW_READ_EVERY_MS,
} from './calendar.constants';
import { GOOGLE_CALENDAR_PORT, GoogleCalendarError, type GoogleCalendarPort } from './google-calendar.port';
import { insidersFor, MeetingStore, type CopyOrigin } from './meeting-store';
import { parseGoogleEvent } from './parse-event';

type MailboxRow = Prisma.MailboxGetPayload<object>;

const DAY_MS = 24 * 60 * 60 * 1000;

/** How a run went: what it stored, and what it passed over. */
export interface CalendarRunResult {
    /** `window`: the whole window was read; `changes`: only what changed since the last run; `skipped`: the calendar could not be read. */
    mode: 'window' | 'changes' | 'skipped';
    /** Meetings stored from this calendar for the first time (a meeting another calendar stored first gains this one's copy). */
    stored: number;
    /** Meetings already stored that were brought up to date. */
    updated: number;
    /** Meetings Google reports called off in this calendar. */
    cancelled: number;
    /** Events that are not meetings with someone outside the workspace (or too big, or declined). */
    passedOver: number;
    /** People created from outside attendees: new leads, owned by the calendar's owner. */
    leadsCreated: number;
    /** Outside attendees suggested to the calendar's owner as leads instead (CAL-3). */
    leadsSuggested: number;
}

/** Why the last run stopped, as kept on the sync state. Never a token or a raw Google body. */
interface SyncErrorRecord {
    code: string;
    message: string;
    at: string;
}

/** What a run knows before it reads anything: the mailbox, who is inside the workspace, the blocklist. */
interface Run {
    mailbox: MailboxRow;
    /** What the meeting store knows about this calendar's copies. */
    origin: CopyOrigin;
    retry: RetryOptions;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Calendar sync (CAL-1): reads a personal mailbox's Google Calendar through the mailbox's own grant and
 * keeps the meetings it holds with people outside the workspace.
 *
 * - **What is read.** The first run reads the last `CALENDAR_INITIAL_DAYS` and the next
 *   `CALENDAR_HORIZON_DAYS`; later runs read only what changed since the run before, and once a day the
 *   whole window again (so occurrences of a recurring meeting are found as they come within the horizon).
 * - **What is kept**, the leads it makes and the events it announces are `MeetingStore`'s rules, the same for
 *   every source: this service reads Google and hands each event to it as this calendar's copy.
 *
 * Runs outside any request (a worker job): the workspace is passed explicitly and no owner scope applies.
 */
@Injectable()
export class CalendarSyncService {
    private readonly logger = new Logger(CalendarSyncService.name);

    constructor(
        private readonly rls: RlsPrismaService,
        private readonly tokens: MailboxTokens,
        private readonly meetings: MeetingStore,
        @Inject(GOOGLE_CALENDAR_PORT) private readonly calendar: GoogleCalendarPort,
    ) {}

    /** One run for one mailbox's calendar. Throws on a failure worth retrying; records every outcome. */
    async syncCalendar(workspaceId: string, mailboxId: string, retry: RetryOptions = {}): Promise<CalendarRunResult> {
        const totals: CalendarRunResult = {
            mode: 'skipped',
            stored: 0,
            updated: 0,
            cancelled: 0,
            passedOver: 0,
            leadsCreated: 0,
            leadsSuggested: 0,
        };
        const mailbox = await this.rls.withWorkspace(workspaceId, (tx) =>
            tx.mailbox.findUnique({ where: { id: mailboxId } }),
        );
        // A pool mailbox is the workspace's outreach, not anyone's calendar.
        if (!mailbox || mailbox.purpose !== 'personal') return totals;
        const unusable = await this.unusable(mailbox);
        if (unusable) {
            await this.recordStopped(mailbox, unusable);
            return totals;
        }

        const state = await this.rls.withWorkspace(workspaceId, (tx) =>
            tx.calendarSyncState.upsert({
                where: { mailboxId },
                create: { mailboxId, workspaceId, status: 'syncing' },
                update: { status: 'syncing' },
            }),
        );
        const startedAt = new Date();
        const whole =
            !state.windowReadAt ||
            !state.lastSyncedAt ||
            startedAt.getTime() - state.windowReadAt.getTime() >= CALENDAR_WINDOW_READ_EVERY_MS;
        const backDays = state.windowReadAt ? CALENDAR_RECENT_DAYS : CALENDAR_INITIAL_DAYS;
        const window = {
            timeMin: new Date(startedAt.getTime() - backDays * DAY_MS),
            timeMax: new Date(startedAt.getTime() + CALENDAR_HORIZON_DAYS * DAY_MS),
            ...(whole ? {} : { updatedMin: new Date(state.lastSyncedAt!.getTime() - CALENDAR_UPDATED_MARGIN_MS) }),
        };
        totals.mode = whole ? 'window' : 'changes';

        try {
            const run = await this.prepare(mailbox, retry);
            let pageToken: string | undefined;
            do {
                const page = await this.request(run, (token) =>
                    this.calendar.listEvents(token, { ...window, ...(pageToken ? { pageToken } : {}) }),
                );
                for (const raw of page.items) {
                    const parsed = parseGoogleEvent(raw, mailbox.id);
                    if (parsed.kind === 'skipped') {
                        totals.passedOver += 1;
                    } else if (parsed.kind === 'cancelled') {
                        const origin = run.origin;
                        if (
                            await this.meetings.store(origin, (tx) =>
                                this.meetings.cancel(tx, origin, parsed.providerEventId),
                            )
                        )
                            totals.cancelled += 1;
                    } else {
                        const origin = run.origin;
                        const written = await this.meetings.store(origin, (tx) =>
                            this.meetings.writeMeeting(tx, origin, parsed),
                        );
                        totals.leadsCreated += written.leads;
                        totals.leadsSuggested += written.suggested;
                        if (written.outcome === 'stored') totals.stored += 1;
                        else if (written.outcome === 'updated') totals.updated += 1;
                        else if (written.outcome === 'passed_over') totals.passedOver += 1;
                    }
                }
                pageToken = page.nextPageToken ?? undefined;
            } while (pageToken);

            await this.rls.withWorkspace(workspaceId, (tx) =>
                tx.calendarSyncState.update({
                    where: { mailboxId },
                    data: {
                        status: 'idle',
                        // The run's start: the next changes-only read reaches back to it (less a margin).
                        lastSyncedAt: startedAt,
                        lastError: Prisma.DbNull,
                        ...(whole ? { windowReadAt: startedAt } : {}),
                    },
                }),
            );
            return totals;
        } catch (error) {
            if (error instanceof MailboxUnavailable) {
                await this.recordStopped(mailbox, unavailableError(error.mailboxStatus));
                return { ...totals, mode: 'skipped' };
            }
            if (error instanceof GoogleCalendarError && error.scopeMissing) {
                // The person withdrew calendar access in their Google account. The mailbox stops claiming
                // it, so the tick stops reading a calendar it may not, and the page offers to connect it.
                await this.forgetCalendarScope(mailbox);
                await this.recordStopped(mailbox, notGrantedError());
                return { ...totals, mode: 'skipped' };
            }
            if (error instanceof GoogleCalendarError && error.apiDisabled) {
                await this.recordStopped(mailbox, {
                    code: 'calendar_api_disabled',
                    message:
                        'the Google Calendar API is not turned on in the workspace’s Google Cloud project; an admin turns it on (Settings → Google)',
                    at: new Date().toISOString(),
                });
                return { ...totals, mode: 'skipped' };
            }
            await this.recordStopped(mailbox, runError(error));
            throw error;
        }
    }

    // ── Before a run ─────────────────────────────────────────────────────────────────────────

    /** Why the calendar cannot be read now, or nothing when it can. */
    private async unusable(mailbox: MailboxRow): Promise<SyncErrorRecord | null> {
        if (mailbox.status !== 'connected') return unavailableError(mailbox.status);
        if (!calendarGranted(mailbox.grantedScopes)) return notGrantedError();
        const owner = await this.rls.withWorkspace(mailbox.workspaceId, (tx) =>
            tx.workspaceMember.findUnique({ where: { id: mailbox.ownerMemberId }, select: { leftAt: true } }),
        );
        if (!owner || owner.leftAt) {
            return {
                code: 'member_left',
                message: 'the calendar’s owner has left the workspace; calendar sync stopped',
                at: new Date().toISOString(),
            };
        }
        return null;
    }

    /** Everyone inside the workspace (members' sign-in addresses, its mailboxes) and the blocklist that applies. */
    private async prepare(mailbox: MailboxRow, retry: RetryOptions): Promise<Run> {
        return this.rls.withWorkspace(mailbox.workspaceId, async (tx) => {
            const { insiders, blocklist } = await insidersFor(tx, {
                memberId: mailbox.ownerMemberId,
                address: mailbox.email,
            });
            const context: WorkspaceRunContext = {
                workspaceId: mailbox.workspaceId,
                capabilities: new Set(),
                actor: { kind: 'sync', id: mailbox.id },
            };
            const origin: CopyOrigin = {
                source: 'google_calendar',
                workspaceId: mailbox.workspaceId,
                memberId: mailbox.ownerMemberId,
                mailboxId: mailbox.id,
                ownerAddress: mailbox.email,
                insiders,
                blocklist,
                leadSource: CALENDAR_LEAD_SOURCE,
                context,
            };
            return { mailbox, origin, retry };
        });
    }

    // ── Google ───────────────────────────────────────────────────────────────────────────────

    /** One Calendar request with the mailbox's token, retrying a transient failure with backoff. */
    private async request<T>(run: Run, call: (token: string) => Promise<T>): Promise<T> {
        const sleep = run.retry.sleep ?? realSleep;
        for (let attempt = 1; ; attempt += 1) {
            try {
                const token = await this.tokens.getAccessToken(run.mailbox.workspaceId, run.mailbox.id);
                return await call(token);
            } catch (error) {
                if (!(error instanceof GoogleCalendarError) || !error.transient || attempt >= CALENDAR_RETRY_ATTEMPTS)
                    throw error;
                await sleep(gmailRetryDelayMs(attempt, run.retry.random));
            }
        }
    }

    // ── State ────────────────────────────────────────────────────────────────────────────────

    /** Drops the calendar's scope from what the mailbox's grant is recorded to carry; its mail is untouched. */
    private async forgetCalendarScope(mailbox: MailboxRow): Promise<void> {
        await this.rls.withWorkspace(mailbox.workspaceId, (tx) =>
            tx.mailbox.update({
                where: { id: mailbox.id },
                data: { grantedScopes: mailbox.grantedScopes.filter((s) => s !== GOOGLE_CALENDAR_SCOPE) },
            }),
        );
    }

    private async recordStopped(mailbox: MailboxRow, error: SyncErrorRecord): Promise<void> {
        const status: MailSyncStatus = 'failed';
        if (error.code === 'internal') this.logger.warn(`calendar of mailbox ${mailbox.id}: ${error.message}`);
        await this.rls.withWorkspace(mailbox.workspaceId, (tx) =>
            tx.calendarSyncState.upsert({
                where: { mailboxId: mailbox.id },
                create: {
                    mailboxId: mailbox.id,
                    workspaceId: mailbox.workspaceId,
                    status,
                    lastError: error as unknown as Prisma.InputJsonObject,
                },
                update: { status, lastError: error as unknown as Prisma.InputJsonObject },
            }),
        );
    }
}

function unavailableError(status: string): SyncErrorRecord {
    return {
        code: status === 'disconnected' ? 'mailbox_disconnected' : 'reconnect_needed',
        message:
            status === 'disconnected'
                ? 'the mailbox is disconnected; calendar sync stopped'
                : 'the mailbox needs to be connected again; calendar sync is paused until it is',
        at: new Date().toISOString(),
    };
}

function notGrantedError(): SyncErrorRecord {
    return {
        code: 'calendar_not_granted',
        message:
            'the mailbox’s Google connection does not include the calendar; connect it again and allow calendar access',
        at: new Date().toISOString(),
    };
}

function runError(error: unknown): SyncErrorRecord {
    const at = new Date().toISOString();
    if (error instanceof GoogleCalendarError) {
        return {
            code: `calendar.${error.reason}`,
            message: `Google Calendar refused the sync (${error.status ?? 'no answer'})`,
            at,
        };
    }
    return { code: 'internal', message: 'the calendar sync failed; it will be retried', at };
}

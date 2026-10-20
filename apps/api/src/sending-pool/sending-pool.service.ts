import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
    REPUTATION_HOUR_MS,
    SENDING_POOL_DEFAULTS,
    SENDING_POOL_WINDOW_MS,
    warmupDay,
    warmupLimit,
    type MailboxPause,
    type MailboxPauseCode,
    type PoolMailboxHealth,
    type SendingDomainSpamRate,
    type SendingPoolSettings,
    type SendingPoolView,
} from '@bylinecrm/shared';
import { DomainEvents } from '../events/domain-events.service';
import { ApiException } from '../infra/errors/api-errors';
import { RlsPrismaService, type WorkspaceClient } from '../infra/rls-prisma.service';
import { WorkspaceContext, type WorkspaceRunContext } from '../infra/workspace-context';
import { DOMAIN_WITH_RATE, domainUsesIn, domainView } from './domain-view';
import { raiseAlert } from '../reputation/alerts';
import { pauseMailbox } from '../reputation/pause';
import { primaryDomainIn, reputationSettingsIn } from '../reputation/settings';
import { sendingDomainOf } from './pool-mailbox';
import { PostmasterService } from './postmaster.service';

type MailboxRow = Prisma.MailboxGetPayload<object>;

/** A pool send the gate refuses (P3-2): paused, an unverified sending domain, or no allowance left. */
export class PoolRefusal extends ApiException {
    constructor(
        code: 'mailbox.paused' | 'mailbox.domain_unverified' | 'mailbox.cap_reached' | 'mailbox.primary_domain',
        message: string,
    ) {
        super(422, code, message);
    }
}

/** A mailbox's allowance in the rolling 24 hours, as the gate and the health view compute it. */
interface Allowance {
    dailyCap: number;
    warmupDay: number | null;
    warmupLimit: number;
    allowance: number;
    used: number;
    /** The latest send that went or is going, for rotation's tie-break and jitter's spacing. */
    lastSentAt: Date | null;
}

const SETTINGS_FIELDS = Object.keys(SENDING_POOL_DEFAULTS) as (keyof SendingPoolSettings)[];

/**
 * The sending pool (P3-2, FR-CRMS-6, FR-CRMS-13): the gate every pool send passes (`claim`), the
 * mailbox a sequence sends from next (`pick`) and when (`nextSendAt`), the rates that pause a
 * mailbox (`evaluate`) and an admin's resume, and the workspace's settings and health view. Personal
 * mailboxes are never gated. Rules and defaults: docs/design-notes/P3-2.md.
 */
@Injectable()
export class SendingPoolService {
    constructor(
        private readonly rls: RlsPrismaService,
        private readonly context: WorkspaceContext,
        private readonly events: DomainEvents,
        private readonly postmaster: PostmasterService,
    ) {}

    // ── The gate ────────────────────────────────────────────────────────────────────────────

    /**
     * Inside the transaction that moves a send to `sending`: refuses a pool send whose mailbox is
     * paused, whose sending domain has not passed its DNS check, or whose allowance for the rolling
     * 24 hours is used. The mailbox row is locked first, so two workers never both take the last slot.
     * A send already counted (it was `sending` before — a retry) is not gated again: it may already
     * be at Gmail, and it holds its slot.
     */
    async claim(
        tx: WorkspaceClient,
        mailboxId: string,
        sendId: string,
        alreadyCounted: boolean,
        now = new Date(),
    ): Promise<void> {
        await tx.$queryRaw`SELECT id FROM mailboxes WHERE id = ${mailboxId}::uuid FOR UPDATE`;
        const mailbox = await tx.mailbox.findUniqueOrThrow({ where: { id: mailboxId } });
        if (mailbox.purpose !== 'pool' || alreadyCounted) return;
        const pause = pauseOf(mailbox);
        if (pause) throw new PoolRefusal('mailbox.paused', `${mailbox.email} is paused: ${pause.message}`);
        // REP-1: the pool is for lookalike domains; nothing sends from one on the workspace's primary domain.
        const reputation = await reputationSettingsIn(tx);
        const primaryDomain = await primaryDomainIn(tx, reputation);
        if (primaryDomain && sendingDomainOf(mailbox.email) === primaryDomain) {
            throw new PoolRefusal(
                'mailbox.primary_domain',
                `${mailbox.email} is on the primary domain ${primaryDomain}; sequences send only from lookalike domains`,
            );
        }
        const domain = await tx.sendingDomain.findUnique({
            where: { workspaceId_domain: { workspaceId: mailbox.workspaceId, domain: sendingDomainOf(mailbox.email) } },
        });
        if (domain?.status !== 'pass') {
            throw new PoolRefusal(
                'mailbox.domain_unverified',
                `${sendingDomainOf(mailbox.email)} has not passed its SPF, DKIM and DMARC check`,
            );
        }
        const allowance = await this.allowanceOf(tx, mailbox, await this.settingsIn(tx), now, sendId);
        if (allowance.used >= allowance.allowance) {
            const why =
                allowance.warmupLimit < allowance.dailyCap
                    ? `its warm-up day ${allowance.warmupDay} limit of ${allowance.warmupLimit}`
                    : `its daily cap of ${allowance.dailyCap}`;
            throw new PoolRefusal(
                'mailbox.cap_reached',
                `${mailbox.email} has sent ${allowance.used} in the last 24 hours, ${why}`,
            );
        }
        // REP-1: and no more than its hourly cap in the rolling hour.
        const hour = await this.sentInLastHour(tx, mailbox.id, now, sendId);
        if (hour >= reputation.poolHourlyCap) {
            throw new PoolRefusal(
                'mailbox.cap_reached',
                `${mailbox.email} has sent ${hour} in the last hour, its hourly cap of ${reputation.poolHourlyCap}`,
            );
        }
    }

    /** Sends from the mailbox that went or are going in the rolling hour before `now` (REP-1). */
    private async sentInLastHour(
        tx: WorkspaceClient,
        mailboxId: string,
        now: Date,
        exceptId?: string,
    ): Promise<number> {
        const since = new Date(now.getTime() - REPUTATION_HOUR_MS);
        const [row] = await tx.$queryRaw<{ used: number }[]>`
            SELECT count(*)::int AS used
            FROM mail_outbound
            WHERE mailbox_id = ${mailboxId}::uuid
              AND status IN ('sending', 'sent')
              AND coalesce(sent_at, last_attempt_at) >= ${since}
              AND id <> ${exceptId ?? '00000000-0000-0000-0000-000000000000'}::uuid`;
        return row?.used ?? 0;
    }

    // ── Rotation and spacing (what a sequence calls) ─────────────────────────────────────────

    /**
     * The pool mailbox to send the next message from, or null when none can: connected, not paused,
     * its domain verified, allowance left. The one with the lowest share of its allowance used, then
     * the longest since its last send, then id — so mailboxes fill evenly whatever their caps.
     * Picking reserves nothing: the claim decides.
     */
    async pick(workspaceId: string, now = new Date()): Promise<string | null> {
        return this.rls.withWorkspace(workspaceId, async (tx) => {
            const settings = await this.settingsIn(tx);
            const reputation = await reputationSettingsIn(tx);
            const primaryDomain = await primaryDomainIn(tx, reputation);
            const verified = new Set(
                (await tx.sendingDomain.findMany({ where: { status: 'pass' }, select: { domain: true } })).map(
                    (d) => d.domain,
                ),
            );
            const mailboxes = await tx.mailbox.findMany({
                where: { purpose: 'pool', status: 'connected', pausedAt: null },
                orderBy: { id: 'asc' },
            });
            const candidates: { id: string; share: number; last: number }[] = [];
            for (const mailbox of mailboxes) {
                if (!verified.has(sendingDomainOf(mailbox.email))) continue;
                if (primaryDomain && sendingDomainOf(mailbox.email) === primaryDomain) continue;
                const a = await this.allowanceOf(tx, mailbox, settings, now);
                if (a.used >= a.allowance) continue;
                if ((await this.sentInLastHour(tx, mailbox.id, now)) >= reputation.poolHourlyCap) continue;
                candidates.push({ id: mailbox.id, share: a.used / a.allowance, last: a.lastSentAt?.getTime() ?? 0 });
            }
            candidates.sort((x, y) => x.share - y.share || x.last - y.last || x.id.localeCompare(y.id));
            return candidates[0]?.id ?? null;
        });
    }

    /**
     * When a mailbox may send next: at least a random `jitterMin…jitterMax` seconds after its latest
     * send — gone, going or waiting — and never before `earliest`.
     */
    async nextSendAt(workspaceId: string, mailboxId: string, earliest: Date): Promise<Date> {
        return this.rls.withWorkspace(workspaceId, async (tx) => {
            const settings = await this.settingsIn(tx);
            const [row] = await tx.$queryRaw<{ last: Date | null }[]>`
                SELECT max(greatest(sent_at, last_attempt_at, send_at)) AS last
                FROM mail_outbound
                WHERE mailbox_id = ${mailboxId}::uuid AND status IN ('scheduled', 'queued', 'sending', 'sent')`;
            const span = settings.jitterMaxSeconds - settings.jitterMinSeconds;
            const gapMs = (settings.jitterMinSeconds + Math.random() * span) * 1000;
            const spaced = row?.last ? row.last.getTime() + gapMs : 0;
            return new Date(Math.max(earliest.getTime(), spaced));
        });
    }

    // ── Rates and pausing ────────────────────────────────────────────────────────────────────

    /**
     * Judges a pool mailbox's bounce and complaint rates over the settings' window and pauses it when
     * one reaches its threshold (with at least `rateMinSample` sends to judge). Idempotent: a paused
     * mailbox stays paused with its first reason. Called by the outbox consumer after each counted
     * bounce or complaint.
     */
    async evaluate(workspaceId: string, mailboxId: string, now = new Date()): Promise<void> {
        await this.rls.withWorkspace(workspaceId, async (tx) => {
            await tx.$queryRaw`SELECT id FROM mailboxes WHERE id = ${mailboxId}::uuid FOR UPDATE`;
            const mailbox = await tx.mailbox.findUnique({ where: { id: mailboxId } });
            if (!mailbox || mailbox.purpose !== 'pool' || mailbox.pausedAt) return;
            const settings = await this.settingsIn(tx);
            const since = new Date(now.getTime() - settings.rateWindowDays * SENDING_POOL_WINDOW_MS);
            const sends = await tx.mailOutbound.count({
                where: { mailboxId, status: 'sent', sentAt: { gte: since } },
            });
            if (sends < settings.rateMinSample) return;
            const [bounces, complaints] = await Promise.all([
                tx.mailBounce.count({ where: { mailboxId, permanent: true, occurredAt: { gte: since } } }),
                tx.suppression.count({
                    where: { reason: 'complaint', createdAt: { gte: since }, outbound: { is: { mailboxId } } },
                }),
            ]);
            const judged: [MailboxPauseCode, number, number][] = [
                ['bounce_rate', bounces, settings.bouncePauseBps],
                ['complaint_rate', complaints, settings.complaintPauseBps],
            ];
            for (const [code, count, thresholdBps] of judged) {
                const rateBps = Math.floor((count * 10_000) / sends);
                if (count === 0 || rateBps < thresholdBps) continue;
                const what = code === 'bounce_rate' ? 'hard bounces' : 'complaints';
                await this.pause(tx, workspaceId, mailboxId, {
                    code,
                    message: `${count} ${what} in ${sends} sends over ${settings.rateWindowDays} days (${percent(rateBps)}), at or above the ${percent(thresholdBps)} threshold`,
                    rateBps,
                    thresholdBps,
                    sends,
                    at: now.toISOString(),
                });
                return;
            }
        });
    }

    /**
     * Judges a sending domain's user-reported spam rate from Postmaster Tools (#129) — the domain's
     * own complaint rate, as Google measures it — against the complaint threshold, and pauses every
     * connected, unpaused pool mailbox on the domain when it is at or above it. Called by the
     * domain check after it stored the rate. Idempotent like `evaluate`: a paused mailbox keeps its
     * first reason, and a rate under the threshold pauses nothing (an admin resumes; the next check
     * judges the next day's rate).
     */
    async evaluateDomain(
        workspaceId: string,
        domain: string,
        rate: SendingDomainSpamRate,
        now = new Date(),
    ): Promise<void> {
        await this.rls.withWorkspace(workspaceId, async (tx) => {
            const settings = await this.settingsIn(tx);
            const reputation = await reputationSettingsIn(tx);
            // REP-2: the kill switch's line, or the pool's complaint threshold if that is stricter.
            const thresholdBps = Math.min(settings.complaintPauseBps, reputation.spamPauseBps);
            if (rate.rateBps < thresholdBps) {
                if (rate.rateBps >= reputation.spamWarnBps) {
                    await this.spamAlert(tx, workspaceId, domain, rate, reputation.spamWarnBps, false);
                }
                return;
            }
            await this.spamAlert(tx, workspaceId, domain, rate, thresholdBps, true);
            if (rate.rateBps >= reputation.spamPauseBps) {
                // REP-2: every cold send on the domain stops — personal mailboxes on it hold new recipients too.
                const personal = await tx.mailbox.findMany({
                    where: { purpose: 'personal', pausedAt: null, email: { endsWith: `@${domain}` } },
                    select: { id: true, email: true },
                });
                for (const m of personal) {
                    if (sendingDomainOf(m.email) !== domain) continue;
                    await pauseMailbox(tx, this.events, workspaceId, m.id, {
                        code: 'domain_spam_rate',
                        message: `${domain} had a user-reported spam rate of ${percent(rate.rateBps)} in Postmaster Tools on ${rate.day}, at or above the ${percent(reputation.spamPauseBps)} kill switch`,
                        rateBps: rate.rateBps,
                        thresholdBps: reputation.spamPauseBps,
                        sends: null,
                        at: now.toISOString(),
                    });
                }
            }
            const mailboxes = await tx.mailbox.findMany({
                where: { purpose: 'pool', status: 'connected', pausedAt: null, email: { endsWith: `@${domain}` } },
                orderBy: { id: 'asc' },
            });
            for (const mailbox of mailboxes) {
                if (sendingDomainOf(mailbox.email) !== domain) continue;
                await tx.$queryRaw`SELECT id FROM mailboxes WHERE id = ${mailbox.id}::uuid FOR UPDATE`;
                const locked = await tx.mailbox.findUniqueOrThrow({ where: { id: mailbox.id } });
                if (locked.pausedAt) continue;
                await this.pause(tx, workspaceId, mailbox.id, {
                    code: 'domain_spam_rate',
                    message: `${domain} had a user-reported spam rate of ${percent(rate.rateBps)} in Postmaster Tools on ${rate.day}, at or above the ${percent(thresholdBps)} threshold`,
                    rateBps: rate.rateBps,
                    thresholdBps,
                    sends: null,
                    at: now.toISOString(),
                });
            }
        });
    }

    /**
     * REP-2: a `spam_rate` guardrail event for the domain's reading — `blocked` when it pauses, `warned` at the
     * warn line — once per domain per day, telling reviewers and admins in the bell.
     */
    private async spamAlert(
        tx: WorkspaceClient,
        workspaceId: string,
        domain: string,
        rate: SendingDomainSpamRate,
        thresholdBps: number,
        pausing: boolean,
    ): Promise<void> {
        await raiseAlert(
            tx,
            this.events,
            { workspaceId, capabilities: new Set() },
            {
                kind: 'spam_rate',
                outcome: pausing ? 'blocked' : 'warned',
                severity: 'high',
                path: 'sync',
                message: pausing
                    ? `${domain}: Postmaster spam rate ${percent(rate.rateBps)} on ${rate.day} is at or above ${percent(thresholdBps)} — cold mail from the domain is paused`
                    : `${domain}: Postmaster spam rate ${percent(rate.rateBps)} on ${rate.day} is at or above the ${percent(thresholdBps)} warning line`,
                detail: { domain, rateBps: String(rate.rateBps), day: rate.day },
                dedupeKey: `spam_rate:${domain}:${pausing ? 'pause' : 'warn'}:${rate.day}`,
            },
            { owner: null, reviewers: true },
        );
    }

    /** The one pause write: the mailbox row (locked by the caller) and the announcement. */
    private async pause(
        tx: WorkspaceClient,
        workspaceId: string,
        mailboxId: string,
        pause: MailboxPause,
    ): Promise<void> {
        await tx.mailbox.update({
            where: { id: mailboxId },
            data: { pausedAt: new Date(pause.at), pauseReason: pause as unknown as Prisma.InputJsonValue },
        });
        await this.events.record(tx, {
            type: 'mailbox.paused',
            object: 'mailbox',
            workspaceId,
            actor: { kind: 'system', id: null },
            occurredAt: pause.at,
            recordId: mailboxId,
            pause,
        });
    }

    // ── Admin routes ─────────────────────────────────────────────────────────────────────────

    /** An admin resumes a paused pool mailbox, saying why. The history stays: rates are judged again on the next bounce. */
    async resume(mailboxId: string, note: string): Promise<PoolMailboxHealth> {
        const context = this.current();
        await this.rls.withWorkspace(async (tx) => {
            const mailbox = await this.poolMailbox(tx, mailboxId);
            const pause = pauseOf(mailbox);
            if (!pause) throw new ConflictException(`${mailbox.email} is not paused`);
            const now = new Date();
            await tx.mailbox.update({
                where: { id: mailboxId },
                data: {
                    pausedAt: null,
                    pauseReason: Prisma.DbNull,
                    resumedAt: now,
                    resumedByMemberId: context.memberId ?? null,
                    resumeNote: note,
                },
            });
            await this.events.record(tx, {
                type: 'mailbox.resumed',
                object: 'mailbox',
                workspaceId: context.workspaceId,
                actor: context.memberId ? { kind: 'member', id: context.memberId } : { kind: 'system', id: null },
                occurredAt: now.toISOString(),
                recordId: mailboxId,
                pause,
            });
        });
        return this.health(mailboxId);
    }

    /** A pool mailbox's own daily cap, or null to take the workspace's. */
    async setMailboxCap(mailboxId: string, dailyCap: number | null): Promise<PoolMailboxHealth> {
        await this.rls.withWorkspace(async (tx) => {
            await this.poolMailbox(tx, mailboxId);
            await tx.mailbox.update({ where: { id: mailboxId }, data: { poolDailyCap: dailyCap } });
        });
        return this.health(mailboxId);
    }

    async updateSettings(input: SendingPoolSettings): Promise<SendingPoolSettings> {
        const context = this.current();
        return this.rls.withWorkspace(async (tx) => {
            const row = await tx.sendingPoolSettings.upsert({
                where: { workspaceId: context.workspaceId },
                create: { workspaceId: context.workspaceId, ...input },
                update: input,
            });
            return pickSettings(row);
        });
    }

    // ── The health view ──────────────────────────────────────────────────────────────────────

    async view(now = new Date()): Promise<SendingPoolView> {
        this.current();
        return this.rls.withWorkspace(async (tx) => {
            const settings = await this.settingsIn(tx);
            const domains = await tx.sendingDomain.findMany({ ...DOMAIN_WITH_RATE, orderBy: { domain: 'asc' } });
            const uses = await domainUsesIn(tx);
            const byDomain = new Map(domains.map((d) => [d.domain, domainView(d, uses, now)]));
            const mailboxes = await tx.mailbox.findMany({
                where: { purpose: 'pool', status: { not: 'disconnected' } },
                orderBy: { email: 'asc' },
            });
            const health: PoolMailboxHealth[] = [];
            for (const mailbox of mailboxes) {
                health.push(healthOf(mailbox, await this.allowanceOf(tx, mailbox, settings, now), byDomain));
            }
            return {
                settings,
                mailboxes: health,
                domains: [...byDomain.values()],
                postmaster: await this.postmaster.viewIn(tx),
            };
        });
    }

    private async health(mailboxId: string): Promise<PoolMailboxHealth> {
        const found = (await this.view()).mailboxes.find((m) => m.mailboxId === mailboxId);
        if (!found) throw new NotFoundException('mailbox not found');
        return found;
    }

    // ── Internals ────────────────────────────────────────────────────────────────────────────

    private async settingsIn(tx: WorkspaceClient): Promise<SendingPoolSettings> {
        const row = await tx.sendingPoolSettings.findFirst();
        return row ? pickSettings(row) : { ...SENDING_POOL_DEFAULTS };
    }

    /**
     * Cap, warm-up day and limit, allowance and what was used of it in the rolling 24 hours: sends
     * that went or are going, each counted once (`exceptId`: the send being claimed).
     */
    private async allowanceOf(
        tx: WorkspaceClient,
        mailbox: MailboxRow,
        settings: SendingPoolSettings,
        now: Date,
        exceptId?: string,
    ): Promise<Allowance> {
        const dailyCap = mailbox.poolDailyCap ?? settings.dailyCap;
        const day = mailbox.warmupStartedAt ? warmupDay(mailbox.warmupStartedAt, now) : null;
        const limit =
            day === null ? dailyCap : warmupLimit(dailyCap, settings.warmupStartPerDay, settings.warmupDays, day);
        const since = new Date(now.getTime() - SENDING_POOL_WINDOW_MS);
        const [row] = await tx.$queryRaw<{ used: number; last: Date | null }[]>`
            SELECT count(*)::int AS used, max(coalesce(sent_at, last_attempt_at)) AS last
            FROM mail_outbound
            WHERE mailbox_id = ${mailbox.id}::uuid
              AND status IN ('sending', 'sent')
              AND coalesce(sent_at, last_attempt_at) >= ${since}
              AND id <> ${exceptId ?? '00000000-0000-0000-0000-000000000000'}::uuid`;
        return {
            dailyCap,
            warmupDay: day,
            warmupLimit: limit,
            allowance: Math.min(dailyCap, limit),
            used: row?.used ?? 0,
            lastSentAt: row?.last ?? null,
        };
    }

    private async poolMailbox(tx: WorkspaceClient, id: string): Promise<MailboxRow> {
        const mailbox = await tx.mailbox.findUnique({ where: { id } });
        if (!mailbox || mailbox.purpose !== 'pool') throw new NotFoundException('pool mailbox not found');
        return mailbox;
    }

    private current(): WorkspaceRunContext {
        const context = this.context.get();
        if (!context) throw new Error('SendingPoolService is used inside a workspace scope');
        return context;
    }
}

function pickSettings(row: SendingPoolSettings): SendingPoolSettings {
    return Object.fromEntries(SETTINGS_FIELDS.map((k) => [k, row[k]])) as unknown as SendingPoolSettings;
}

function pauseOf(mailbox: MailboxRow): MailboxPause | null {
    return mailbox.pausedAt && mailbox.pauseReason ? (mailbox.pauseReason as unknown as MailboxPause) : null;
}

function percent(bps: number): string {
    return `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`;
}

function healthOf(
    mailbox: MailboxRow,
    a: Allowance,
    domains: Map<string, ReturnType<typeof domainView>>,
): PoolMailboxHealth {
    const domain = domains.get(sendingDomainOf(mailbox.email)) ?? null;
    const paused = pauseOf(mailbox);
    return {
        mailboxId: mailbox.id,
        email: mailbox.email,
        status: mailbox.status,
        dailyCapOverride: mailbox.poolDailyCap,
        dailyCap: a.dailyCap,
        warmupDay: a.warmupDay,
        warmupLimit: a.warmupLimit,
        allowance: a.allowance,
        used: a.used,
        paused,
        domain,
        canSend: mailbox.status === 'connected' && !paused && domain?.status === 'pass' && a.used < a.allowance,
    };
}

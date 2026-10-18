import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DEFAULT_DKIM_SELECTOR, SENDING_DOMAIN_RECHECK_MS, type SendingDomainView } from '@bylinecrm/shared';
import { PrismaService } from '../infra/prisma.service';
import { RlsPrismaService } from '../infra/rls-prisma.service';
import { WorkspaceContext } from '../infra/workspace-context';
import { domainCheckNames, evaluateDomain } from './domain-checks';
import { DOMAIN_WITH_RATE, domainUsesIn, domainView, type DomainRow } from './domain-view';
import { DNS_PORT, DnsLookupFailed, type DnsPort } from './dns.port';
import { nextPostmasterReadAt, nextUtcDay } from './postmaster-schedule';
import { PostmasterRequestFailed } from './postmaster.port';
import { PostmasterService } from './postmaster.service';
import { SENDING_DOMAIN_CHECK_BATCH } from './sending-pool.constants';
import { SendingPoolService } from './sending-pool.service';

/**
 * Sending domains and their checks (FR-CRMS-13, #190): every connected mailbox's domain — pool or
 * personal — and every domain the connected Postmaster Tools account lists. SPF, DKIM and DMARC by
 * DNS lookup, and — once a Postmaster Tools account is connected (#129) — the domain's user-reported
 * spam rates for the last 30 days, yesterday's of which pauses every *pool* mailbox on the domain
 * at the complaint threshold. A personal mailbox's domain is monitored, never gated. Neither is ever
 * asked inside a transaction. On demand, and again every `SENDING_DOMAIN_RECHECK_MS` from the
 * maintenance job, which also lists the account's domains once a day. Until a pool domain passes
 * DNS, the gate refuses every send from it. A lookup that fails (timeout, SERVFAIL, a 5xx from
 * Google) fails its step and says so: "could not check" is never "passed", and never a rate of
 * zero. Postmaster is asked at most once per domain per day, and a rate limit (#183) or a spent
 * quota (#190) keeps the last reading and waits its turn.
 */
@Injectable()
export class SendingDomainsService {
    private readonly logger = new Logger(SendingDomainsService.name);

    constructor(
        private readonly rls: RlsPrismaService,
        private readonly ownerPrisma: PrismaService,
        private readonly context: WorkspaceContext,
        private readonly postmaster: PostmasterService,
        private readonly pool: SendingPoolService,
        @Inject(DNS_PORT) private readonly dns: DnsPort,
    ) {}

    async list(): Promise<SendingDomainView[]> {
        return this.rls.withWorkspace(async (tx) => {
            const uses = await domainUsesIn(tx);
            return (await tx.sendingDomain.findMany({ ...DOMAIN_WITH_RATE, orderBy: { domain: 'asc' } })).map((row) =>
                domainView(row, uses),
            );
        });
    }

    async get(id: string): Promise<SendingDomainView> {
        return this.rls.withWorkspace(async (tx) => domainView(await this.find(tx, id), await domainUsesIn(tx)));
    }

    /** The DKIM selector to check; a change makes the domain due for a check at once. */
    async update(id: string, dkimSelector: string): Promise<SendingDomainView> {
        return this.rls.withWorkspace(async (tx) => {
            await this.find(tx, id);
            const row = await tx.sendingDomain.update({
                ...DOMAIN_WITH_RATE,
                where: { id },
                data: { dkimSelector, nextCheckAt: new Date() },
            });
            return domainView(row, await domainUsesIn(tx));
        });
    }

    /** Checks one domain now (a member's "check again"). */
    async check(id: string): Promise<SendingDomainView> {
        const context = this.context.get();
        if (!context) throw new Error('SendingDomainsService.check is used inside a workspace scope');
        const row = await this.rls.withWorkspace((tx) => this.find(tx, id));
        const checked = await this.run(context.workspaceId, row);
        return this.rls.withWorkspace(async (tx) => domainView(checked, await domainUsesIn(tx)));
    }

    /**
     * The maintenance job, across workspaces (as the owner): each connected Postmaster Tools account's
     * domains when its daily listing is due, then every domain due for a check, the most overdue first.
     */
    async checkDue(now = new Date()): Promise<number> {
        await this.listPostmasterDomains(now);
        const due = await this.ownerPrisma.sendingDomain.findMany({
            ...DOMAIN_WITH_RATE,
            where: { nextCheckAt: { lte: now } },
            orderBy: { nextCheckAt: 'asc' },
            take: SENDING_DOMAIN_CHECK_BATCH,
        });
        for (const row of due) {
            try {
                await this.run(row.workspaceId, row);
            } catch (error) {
                this.logger.error(
                    `sending domain ${row.domain}: check failed to record: ${error instanceof Error ? error.message : String(error)}`,
                );
            }
        }
        return due.length;
    }

    /**
     * Every domain a connected Postmaster Tools account holds becomes a sending domain of its
     * workspace (#190), due for its first check; one it no longer holds stays (with its history)
     * but is no longer marked as listed. Once a day per account; a listing Google did not answer is
     * logged — with Google's status and message — and tried again at the check's cadence.
     */
    private async listPostmasterDomains(now: Date): Promise<void> {
        const due = await this.ownerPrisma.postmasterConnection.findMany({
            where: { status: 'connected', OR: [{ domainsNextListAt: null }, { domainsNextListAt: { lte: now } }] },
            select: { workspaceId: true },
        });
        for (const { workspaceId } of due) {
            try {
                let listed;
                try {
                    listed = await this.postmaster.domains(workspaceId);
                } catch (error) {
                    if (!(error instanceof PostmasterRequestFailed)) throw error;
                    this.logger.warn(`${error.message} (listing domains in ${workspaceId})`);
                    await this.rls.withWorkspace(workspaceId, (tx) =>
                        tx.postmasterConnection.update({
                            where: { workspaceId },
                            data: { domainsNextListAt: new Date(now.getTime() + SENDING_DOMAIN_RECHECK_MS) },
                        }),
                    );
                    continue;
                }
                // Needs reconnecting: the connection says why; the next connect lists at once.
                if (listed === null) continue;
                const names = [...new Set(listed.map((d) => d.domain))];
                await this.rls.withWorkspace(workspaceId, async (tx) => {
                    await tx.sendingDomain.createMany({
                        // Due in this very pass: the job checks it right after listing.
                        data: names.map((domain) => ({
                            workspaceId,
                            domain,
                            dkimSelector: DEFAULT_DKIM_SELECTOR,
                            nextCheckAt: now,
                        })),
                        skipDuplicates: true,
                    });
                    await tx.sendingDomain.updateMany({
                        where: { domain: { in: names }, inPostmaster: false },
                        data: { inPostmaster: true },
                    });
                    await tx.sendingDomain.updateMany({
                        where: { domain: { notIn: names }, inPostmaster: true },
                        data: { inPostmaster: false },
                    });
                    await tx.postmasterConnection.update({
                        where: { workspaceId },
                        data: { domainsNextListAt: nextUtcDay(now) },
                    });
                });
            } catch (error) {
                this.logger.error(
                    `Postmaster Tools domains in ${workspaceId}: listing failed to record: ${error instanceof Error ? error.message : String(error)}`,
                );
            }
        }
    }

    private async run(workspaceId: string, row: DomainRow): Promise<DomainRow> {
        const names = domainCheckNames(row.domain, row.dkimSelector);
        const looked = new Map<string, string[] | DnsLookupFailed>();
        await Promise.all(
            Object.values(names).map(async (name) => {
                try {
                    looked.set(name, await this.dns.resolveTxt(name));
                } catch (error) {
                    if (!(error instanceof DnsLookupFailed)) throw error;
                    looked.set(name, error);
                }
            }),
        );
        const failed = [...looked.values()].filter((v): v is DnsLookupFailed => v instanceof DnsLookupFailed);
        const check = evaluateDomain(row.domain, row.dkimSelector, (name) => {
            const value = looked.get(name);
            return Array.isArray(value) ? value : [];
        });
        // A lookup that could not be made fails its step with the reason, whatever it would have read.
        for (const error of failed) {
            const step = (Object.keys(names) as (keyof typeof names)[]).find((k) => names[k] === error.lookedUp);
            if (step)
                check[step] = { outcome: 'fail', message: `could not look up ${error.lookedUp}: ${error.reason}` };
        }
        const passed = check.spf.outcome === 'pass' && check.dkim.outcome === 'pass' && check.dmarc.outcome === 'pass';
        const now = new Date();
        // Postmaster Tools is asked only when the domain is due for it (#183): a day's reading is read
        // once, a rate limit waits its turn. A check before then keeps what the last ask learned.
        const askPostmaster = !row.postmasterNextReadAt || row.postmasterNextReadAt <= now;
        const reading = askPostmaster ? await this.postmaster.read(workspaceId, row.domain, now) : null;
        const limited = reading?.status === 'rate_limited' || reading?.status === 'quota_exhausted';
        const updated = await this.rls.withWorkspace(workspaceId, async (tx) => {
            // One row per domain and day (#190: every day of the range Google answered for): a day
            // read again is replaced, so the view shows the latest.
            for (const stats of reading?.history ?? []) {
                const day = new Date(stats.day);
                const values = { spamRateBps: stats.spamRateBps, deliveryErrorBps: stats.deliveryErrorBps };
                await tx.sendingDomainStat.upsert({
                    where: { domainId_day: { domainId: row.id, day } },
                    create: { workspaceId, domainId: row.id, day, ...values, fetchedAt: now },
                    update: { ...values, fetchedAt: now },
                });
            }
            return tx.sendingDomain.update({
                ...DOMAIN_WITH_RATE,
                where: { id: row.id },
                data: {
                    status: passed ? 'pass' : 'fail',
                    lastCheck: check as unknown as Prisma.InputJsonValue,
                    checkedAt: now,
                    nextCheckAt: new Date(now.getTime() + SENDING_DOMAIN_RECHECK_MS),
                    ...(reading
                        ? {
                              postmasterStatus: reading.status,
                              postmasterMessage: reading.message,
                              postmasterReadAt: reading.status === 'not_connected' ? row.postmasterReadAt : now,
                              postmasterNextReadAt: nextPostmasterReadAt(reading, now, row.postmasterLimitedTimes),
                              postmasterLimitedTimes: limited ? row.postmasterLimitedTimes + 1 : 0,
                          }
                        : {}),
                },
            });
        });
        // The pause is judged on yesterday's rate alone (the pool's gate; a personal domain pauses nothing).
        if (reading?.rate) await this.pool.evaluateDomain(workspaceId, row.domain, reading.rate, now);
        return updated;
    }

    private async find(tx: Prisma.TransactionClient, id: string): Promise<DomainRow> {
        const row = await tx.sendingDomain.findUnique({ ...DOMAIN_WITH_RATE, where: { id } });
        if (!row) throw new NotFoundException('sending domain not found');
        return row;
    }
}

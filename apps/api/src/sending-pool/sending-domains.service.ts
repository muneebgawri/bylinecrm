import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { SENDING_DOMAIN_RECHECK_MS, type SendingDomainView } from '@bylinecrm/shared';
import { PrismaService } from '../infra/prisma.service';
import { RlsPrismaService } from '../infra/rls-prisma.service';
import { WorkspaceContext } from '../infra/workspace-context';
import { domainCheckNames, evaluateDomain } from './domain-checks';
import { DOMAIN_WITH_RATE, domainView, type DomainRow } from './domain-view';
import { DNS_PORT, DnsLookupFailed, type DnsPort } from './dns.port';
import { PostmasterService } from './postmaster.service';
import { SENDING_DOMAIN_CHECK_BATCH } from './sending-pool.constants';
import { SendingPoolService } from './sending-pool.service';

/**
 * Pool mailboxes' sending domains and their checks (FR-CRMS-13): SPF, DKIM and DMARC by DNS lookup,
 * and — once a Postmaster Tools account is connected (#129) — the domain's user-reported spam rate
 * for yesterday, which pauses every pool mailbox on the domain at the complaint threshold. Neither
 * is ever asked inside a transaction. On demand, and again every `SENDING_DOMAIN_RECHECK_MS` from
 * the maintenance job. Until a domain passes DNS, the gate refuses every send from it. A lookup that
 * fails (timeout, SERVFAIL, a 5xx from Google) fails its step and says so: "could not check" is
 * never "passed", and never a rate of zero.
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
        return this.rls.withWorkspace(async (tx) =>
            (await tx.sendingDomain.findMany({ ...DOMAIN_WITH_RATE, orderBy: { domain: 'asc' } })).map(domainView),
        );
    }

    /** The DKIM selector to check; a change makes the domain due for a check at once. */
    async update(id: string, dkimSelector: string): Promise<SendingDomainView> {
        return this.rls.withWorkspace(async (tx) => {
            await this.find(tx, id);
            return domainView(
                await tx.sendingDomain.update({
                    ...DOMAIN_WITH_RATE,
                    where: { id },
                    data: { dkimSelector, nextCheckAt: new Date() },
                }),
            );
        });
    }

    /** Checks one domain now (a member's "check again"). */
    async check(id: string): Promise<SendingDomainView> {
        const context = this.context.get();
        if (!context) throw new Error('SendingDomainsService.check is used inside a workspace scope');
        const row = await this.rls.withWorkspace((tx) => this.find(tx, id));
        return domainView(await this.run(context.workspaceId, row));
    }

    /** The maintenance job: every domain due, the most overdue first, across workspaces (as the owner). */
    async checkDue(now = new Date()): Promise<number> {
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
        const reading = await this.postmaster.read(workspaceId, row.domain, now);
        const updated = await this.rls.withWorkspace(workspaceId, async (tx) => {
            if (reading.rate) {
                // One row per domain and day: a day read again is replaced, so the view shows the latest.
                await tx.sendingDomainStat.upsert({
                    where: { domainId_day: { domainId: row.id, day: new Date(reading.rate.day) } },
                    create: {
                        workspaceId,
                        domainId: row.id,
                        day: new Date(reading.rate.day),
                        spamRateBps: reading.rate.rateBps,
                        fetchedAt: now,
                    },
                    update: { spamRateBps: reading.rate.rateBps, fetchedAt: now },
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
                    postmasterStatus: reading.status,
                    postmasterMessage: reading.message,
                },
            });
        });
        if (reading.rate) await this.pool.evaluateDomain(workspaceId, row.domain, reading.rate, now);
        return updated;
    }

    private async find(tx: Prisma.TransactionClient, id: string): Promise<DomainRow> {
        const row = await tx.sendingDomain.findUnique({ ...DOMAIN_WITH_RATE, where: { id } });
        if (!row) throw new NotFoundException('sending domain not found');
        return row;
    }
}

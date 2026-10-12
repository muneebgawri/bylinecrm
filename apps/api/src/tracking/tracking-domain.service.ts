import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { TrackingDomainCheck, TrackingDomainView, TrackingSettingsView } from '@bylinecrm/shared';
import { Prisma, type TrackingDomain } from '@prisma/client';
import { ENV, type Env } from '../config/env';
import { UniqueConflict } from '../infra/errors/api-errors';
import { uniqueViolation } from '../infra/prisma-errors';
import { RlsPrismaService } from '../infra/rls-prisma.service';
import { WorkspaceContext } from '../infra/workspace-context';
import { DNS_PORT, DnsLookupFailed, type DnsPort } from '../sending-pool/dns.port';

/**
 * The workspace's short-link domain (P3-4, FR-CRMS-8): set by an admin, checked on demand through the
 * DNS port — never inside a transaction — and used by the send path only while the check passes.
 * The CNAME must point at the API's host (`APP_URL`), which serves the public routes for every
 * workspace's domain; the domain is one workspace's (`409` to a second). There is no scheduled
 * re-check: a domain that stops resolving stops redirecting, which the admin sees and checks.
 */
@Injectable()
export class TrackingDomainService {
    constructor(
        @Inject(ENV) private readonly env: Env,
        private readonly rls: RlsPrismaService,
        private readonly context: WorkspaceContext,
        @Inject(DNS_PORT) private readonly dns: DnsPort,
    ) {}

    /** The host the domain's CNAME must point at. */
    cnameTarget(): string {
        return new URL(this.env.APP_URL).hostname.toLowerCase();
    }

    async get(): Promise<TrackingSettingsView> {
        const row = await this.rls.withWorkspace((tx) =>
            tx.trackingDomain.findUnique({ where: { workspaceId: this.workspaceId() } }),
        );
        return this.settings(row);
    }

    /** Sets or replaces the domain; a different domain starts unchecked. */
    async set(domain: string): Promise<TrackingSettingsView> {
        const workspaceId = this.workspaceId();
        try {
            const row = await this.rls.withWorkspace(async (tx) => {
                const current = await tx.trackingDomain.findUnique({ where: { workspaceId } });
                if (current?.domain === domain) return current;
                return tx.trackingDomain.upsert({
                    where: { workspaceId },
                    create: { workspaceId, domain },
                    update: { domain, status: 'unchecked', lastCheck: Prisma.DbNull, checkedAt: null },
                });
            });
            return this.settings(row);
        } catch (error) {
            if (uniqueViolation(error)) throw new UniqueConflict('another workspace uses this domain', 'domain');
            throw error;
        }
    }

    async remove(): Promise<void> {
        await this.rls.withWorkspace((tx) =>
            tx.trackingDomain.deleteMany({ where: { workspaceId: this.workspaceId() } }),
        );
    }

    /** Looks the CNAME up now and records the outcome. `404` when no domain is set. */
    async check(): Promise<TrackingSettingsView> {
        const workspaceId = this.workspaceId();
        const row = await this.rls.withWorkspace((tx) => tx.trackingDomain.findUnique({ where: { workspaceId } }));
        if (!row) throw new NotFoundException('no short-link domain is set');
        // No transaction is open here: the lookup reaches DNS.
        const check = await this.lookUp(row.domain);
        return this.settings(
            await this.rls.withWorkspace((tx) =>
                tx.trackingDomain.update({
                    where: { workspaceId },
                    data: {
                        status: check.outcome,
                        lastCheck: check as unknown as Prisma.InputJsonValue,
                        checkedAt: new Date(),
                    },
                }),
            ),
        );
    }

    private async lookUp(domain: string): Promise<TrackingDomainCheck> {
        const target = this.cnameTarget();
        let found: string | null;
        try {
            found = await this.dns.resolveCname(domain);
        } catch (error) {
            if (!(error instanceof DnsLookupFailed)) throw error;
            return { outcome: 'fail', message: `could not look up ${domain}: ${error.reason}` };
        }
        if (found === null) {
            return {
                outcome: 'fail',
                message: `no CNAME record found for ${domain}; publish ${domain} CNAME ${target}`,
            };
        }
        if (found.replace(/\.$/, '') !== target) {
            return { outcome: 'fail', message: `${domain} is a CNAME to ${found}, not to ${target}` };
        }
        return { outcome: 'pass', message: `${domain} is a CNAME to ${target}` };
    }

    private settings(row: TrackingDomain | null): TrackingSettingsView {
        return { cnameTarget: this.cnameTarget(), domain: row ? view(row) : null };
    }

    private workspaceId(): string {
        const context = this.context.get();
        if (!context) throw new Error('TrackingDomainService is used inside a workspace scope');
        return context.workspaceId;
    }
}

function view(row: TrackingDomain): TrackingDomainView {
    return {
        domain: row.domain,
        status: row.status,
        lastCheck: (row.lastCheck as unknown as TrackingDomainCheck | null) ?? null,
        checkedAt: row.checkedAt?.toISOString() ?? null,
        updatedAt: row.updatedAt.toISOString(),
    };
}

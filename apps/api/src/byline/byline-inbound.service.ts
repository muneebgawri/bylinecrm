import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { parseLeadPayload, verifyWebhook, type BylineLeadPayload } from '@byline/contract';
import type { DomainEvent, Phones } from '@bylinecrm/shared';
import { RateLimiter } from '../auth/rate-limiter.service';
import { DomainEvents } from '../events/domain-events.service';
import { ApiException, RateLimited } from '../infra/errors/api-errors';
import { uniqueViolation } from '../infra/prisma-errors';
import { PrismaService } from '../infra/prisma.service';
import { RlsPrismaService, type WorkspaceClient } from '../infra/rls-prisma.service';
import { SecretBox } from '../infra/secret-box';
import { WorkspaceContext, type WorkspaceRunContext } from '../infra/workspace-context';
import { CompaniesService } from '../records/companies.service';
import { CompanyOwnership, companyDomainOfAddress } from '../records/company-ownership';
import { PeopleService } from '../records/people.service';
import {
    BYLINE_INBOUND_FAILURE_LIMIT,
    BYLINE_INBOUND_FAILURE_WINDOW_S,
    bylineInboundRateKey,
    bylineSource,
} from './byline.constants';
import type { BylineLeadResult } from './responses';
import { leadPhone } from './lead-phone';
import { RotationService } from '../cadence/rotation.service';
import { dealTo } from './round-robin';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * BylineAI's lead webhook (BYL-1, #207). The path names the workspace; its secret is read through the owner client
 * (nothing else is), and the raw body must carry that secret's `x-byline-signature` or nothing is read. Then, as a
 * job acting for the workspace:
 *
 * - **Idempotent on `lead_id`**: a lead the workspace already took in is answered `duplicate`, the same person.
 * - **The person** is found by address, or made. One already in the CRM keeps its owner and company; blanks are
 *   filled. One someone removed is not brought back (`rejected`).
 * - **The owner** follows OWN-2: the owner of the company the address's domain belongs to; else the next member on
 *   the round-robin list (who then owns the company too, so its next lead follows); else nobody — the Leads queue.
 * - **The company** is found by domain (own or other), or made from the address's domain; free mail has none.
 * - **The source** is `byline:<source_key>`.
 */
@Injectable()
export class BylineInboundService {
    private readonly logger = new Logger(BylineInboundService.name);

    constructor(
        private readonly ownerPrisma: PrismaService,
        private readonly rls: RlsPrismaService,
        private readonly context: WorkspaceContext,
        private readonly secrets: SecretBox,
        private readonly limiter: RateLimiter,
        private readonly people: PeopleService,
        private readonly companies: CompaniesService,
        private readonly ownership: CompanyOwnership,
        private readonly events: DomainEvents,
        private readonly rotation: RotationService,
    ) {}

    async receive(
        workspaceId: string,
        rawBody: Buffer | undefined,
        signature: string | undefined,
        body: unknown,
        clientIp: string,
    ): Promise<BylineLeadResult> {
        const settings = UUID.test(workspaceId)
            ? await this.ownerPrisma.bylineSettings.findUnique({
                  where: { workspaceId },
                  select: { secretCiphertext: true },
              })
            : null;
        // A link with only the API side (BYL-2) takes no deliveries.
        if (!settings?.secretCiphertext) {
            await this.refused(clientIp);
            throw new NotFoundException('not found');
        }
        if (!rawBody || !verifyWebhook(this.secrets.open(settings.secretCiphertext), rawBody, signature)) {
            await this.record(workspaceId, 'bad_signature');
            await this.refused(clientIp);
            throw new ApiException(401, 'unauthorized', 'the delivery is not signed with this workspace’s secret');
        }
        const parsed = parseLeadPayload(body);
        const result: BylineLeadResult = parsed.ok
            ? await this.ingest(workspaceId, parsed.lead)
            : { status: 'rejected', reason: parsed.reason };
        await this.record(workspaceId, result.status);
        return result;
    }

    /** The lead taken in, as a job acting for the workspace. */
    async ingest(workspaceId: string, lead: BylineLeadPayload): Promise<BylineLeadResult> {
        const context: WorkspaceRunContext = {
            workspaceId,
            capabilities: new Set(['record:read', 'record:write']),
            actor: { kind: 'sync', id: null },
        };
        try {
            return await this.context.run(context, () =>
                this.rls.withWorkspace(workspaceId, (tx) => this.ingestIn(tx, context, lead)),
            );
        } catch (error) {
            // A concurrent delivery of the same lead committed first.
            if (uniqueViolation(error)) return this.duplicateOf(workspaceId, lead.lead_id);
            if (error instanceof ApiException && error.getStatus() < 500) {
                return { status: 'rejected', reason: error.message };
            }
            throw error;
        }
    }

    private async ingestIn(
        tx: WorkspaceClient,
        context: WorkspaceRunContext,
        lead: BylineLeadPayload,
    ): Promise<BylineLeadResult> {
        const seen = await tx.bylineLead.findUnique({
            where: { workspaceId_leadId: { workspaceId: context.workspaceId, leadId: lead.lead_id } },
            select: { personId: true },
        });
        if (seen) return { status: 'duplicate', personId: seen.personId };

        const source = bylineSource(lead.source_key);
        const recorded: DomainEvent[] = [];
        const known = await tx.person.findFirst({
            where: { emailPrimary: lead.email },
            select: {
                id: true,
                deletedAt: true,
                nameFirst: true,
                nameLast: true,
                jobTitle: true,
                country: true,
                phones: true,
            },
        });
        if (known?.deletedAt) return { status: 'rejected', reason: 'the person was removed from the CRM' };

        // E.164 or dialled-with-country becomes the person's phone; what cannot be parsed is kept raw on the lead.
        const phone = leadPhone(lead.phone, country(lead.country));
        const phoneRaw = lead.phone && !phone ? lead.phone : null;
        let personId: string;
        let status: 'ingested' | 'duplicate';
        if (known) {
            // Already in the CRM: its owner and company stand; what it lacks is filled in.
            const patch = {
                ...(!known.nameFirst && lead.first_name ? { nameFirst: lead.first_name } : {}),
                ...(!known.nameLast && lead.last_name ? { nameLast: lead.last_name } : {}),
                ...(!known.jobTitle && lead.job_title ? { jobTitle: lead.job_title } : {}),
                ...(!known.country && country(lead.country) ? { country: country(lead.country) } : {}),
                ...(phone && !(known.phones as Phones | null)?.primary
                    ? { phones: { primary: phone, additional: (known.phones as Phones | null)?.additional ?? [] } }
                    : {}),
            };
            if (Object.keys(patch).length > 0) {
                const { event } = await this.people.updateIn(tx, context, known.id, patch);
                if (event) recorded.push(event);
            }
            personId = known.id;
            status = 'duplicate';
        } else {
            const { companyId, ownerId, events } = await this.place(tx, context, lead);
            recorded.push(...events);
            const { row, event } = await this.people.createIn(tx, context, {
                nameFirst: lead.first_name ?? '',
                nameLast: lead.last_name ?? '',
                emails: { primary: lead.email, additional: [] },
                jobTitle: lead.job_title ?? null,
                country: country(lead.country),
                phones: { primary: phone, additional: [] },
                links: { linkedin: lead.linkedin_url ? { url: lead.linkedin_url, label: null } : null, x: null },
                source,
                ownerId,
                companyId,
            });
            recorded.push(event);
            personId = row.id;
            status = 'ingested';
        }
        await tx.bylineLead.create({
            data: { workspaceId: context.workspaceId, leadId: lead.lead_id, personId, source, phoneRaw },
        });
        await this.events.recordAll(tx, recorded);
        return { status, personId };
    }

    /** OWN-2's answer for a new lead: its company (found or made) and its owner. */
    private async place(
        tx: WorkspaceClient,
        context: WorkspaceRunContext,
        lead: BylineLeadPayload,
    ): Promise<{ companyId: string | null; ownerId: string | null; events: DomainEvent[] }> {
        const domain = companyDomainOfAddress(lead.email);
        const company = await this.ownership.companyForDomain(context, domain);
        if (company?.ownerId) return { companyId: company.companyId, ownerId: company.ownerId, events: [] };

        const ownerId = await this.nextMember(tx, context.workspaceId);
        const events: DomainEvent[] = [];
        if (company) {
            // An unowned company goes with its lead, so the next lead from it reaches the same member.
            if (ownerId) {
                const { event } = await this.companies.updateIn(tx, context, company.companyId, { ownerId });
                if (event) events.push(event);
            }
            return { companyId: company.companyId, ownerId, events };
        }
        if (!domain) return { companyId: null, ownerId, events };
        const { row, event } = await this.companies.createIn(tx, context, {
            name: lead.company_name ?? domain,
            domain,
            ownerId,
        });
        events.push(event);
        return { companyId: row.id, ownerId, events };
    }

    /** The next member on the round-robin list still in the workspace; null for none (the Leads queue). */
    private async nextMember(tx: WorkspaceClient, workspaceId: string): Promise<string | null> {
        const settings = await tx.bylineSettings.findFirst({ select: { id: true, roundRobinMemberIds: true } });
        // CADENCE-1: no list of its own — the workspace's rotation deals it, when intake is on.
        if (!settings || settings.roundRobinMemberIds.length === 0) return this.rotation.dealIntake(tx, workspaceId);
        const members = await tx.workspaceMember.findMany({
            where: { id: { in: settings.roundRobinMemberIds }, leftAt: null },
            select: { id: true },
        });
        if (members.length === 0) return null;
        // The increment takes the row's lock: concurrent leads are dealt one after the other.
        const { roundRobinCursor } = await tx.bylineSettings.update({
            where: { id: settings.id },
            data: { roundRobinCursor: { increment: 1 } },
            select: { roundRobinCursor: true },
        });
        this.logger.debug(`workspace ${workspaceId}: lead ${roundRobinCursor} dealt`);
        return dealTo(settings.roundRobinMemberIds, new Set(members.map((m) => m.id)), roundRobinCursor);
    }

    private async duplicateOf(workspaceId: string, leadId: string): Promise<BylineLeadResult> {
        const seen = await this.rls.withWorkspace(workspaceId, (tx) =>
            tx.bylineLead.findUnique({
                where: { workspaceId_leadId: { workspaceId, leadId } },
                select: { personId: true },
            }),
        );
        return seen ? { status: 'duplicate', personId: seen.personId } : { status: 'rejected', reason: 'conflict' };
    }

    private async refused(clientIp: string): Promise<void> {
        const over = await this.limiter.hit(
            bylineInboundRateKey(clientIp),
            BYLINE_INBOUND_FAILURE_LIMIT,
            BYLINE_INBOUND_FAILURE_WINDOW_S,
        );
        if (over) throw new RateLimited('too many refused deliveries; try again later');
    }

    private async record(workspaceId: string, result: string): Promise<void> {
        await this.rls.withWorkspace(workspaceId, (tx) =>
            tx.bylineSettings.updateMany({ data: { lastDeliveryAt: new Date(), lastDeliveryResult: result } }),
        );
    }
}

/** An ISO 3166-1 alpha-2 country, upper case, or null. */
function country(value: string | undefined): string | null {
    const upper = value?.trim().toUpperCase();
    return upper && /^[A-Z]{2}$/.test(upper) ? upper : null;
}

import { Injectable, NotFoundException } from '@nestjs/common';
import {
    TRACKING_CLICK_PATH,
    TRACKING_OPEN_PATH,
    type DomainEvent,
    type EmailTrackingPayload,
} from '@bylinecrm/shared';
import type { TrackingKind } from '@prisma/client';
import { hashToken, randomToken } from '../auth/tokens';
import { DomainEvents } from '../events/domain-events.service';
import { PrismaService } from '../infra/prisma.service';
import { RlsPrismaService } from '../infra/rls-prisma.service';
import { botReason } from './bots';
import { rewriteLinks, trackableLinks, withOpenPixel } from './link-rewriter';
import { TRACKING_TOKEN_BYTES } from './tracking.constants';

/** What a public hit asks for: which token, from what client, when. */
export interface HitRequest {
    userAgent: string | undefined;
    at: Date;
}

/**
 * Tracked links and opens (P3-4, FR-CRMS-8). `trackOutreach` is the send path's one call: while the
 * workspace's short-link domain passes its check, every link in the HTML becomes a short link and the
 * open pixel is added; otherwise the mail goes out as it is. `hit` is the public routes' one call: the
 * token names its workspace (it is opaque: 256 random bits, stored hashed), the hit is recorded there,
 * and — unless it is a scanner's — announced as `email.clicked` / `email.opened` through the outbox,
 * in the same transaction as the hit. An open is announced as *indicative*.
 */
@Injectable()
export class TrackingService {
    constructor(
        private readonly rls: RlsPrismaService,
        // The public route has no workspace until the token names one: the owner client reads that
        // one column by hash, as the unsubscribe route does. Everything after runs under RLS.
        private readonly ownerPrisma: PrismaService,
        private readonly events: DomainEvents,
    ) {}

    /**
     * The HTML with its links rewritten and the pixel added, or unchanged when the workspace has no
     * verified short-link domain. `exclude` names the links never rewritten (the unsubscribe link).
     */
    async trackOutreach(
        workspaceId: string,
        input: { outboundId: string; html: string; exclude: readonly string[] },
    ): Promise<string> {
        const domain = await this.rls.withWorkspace(workspaceId, (tx) =>
            tx.trackingDomain.findUnique({ where: { workspaceId }, select: { domain: true, status: true } }),
        );
        if (!domain || domain.status !== 'pass') return input.html;
        const links = trackableLinks(input.html, input.exclude).map((url) => ({
            url,
            token: randomToken(TRACKING_TOKEN_BYTES),
        }));
        const open = randomToken(TRACKING_TOKEN_BYTES);
        await this.rls.withWorkspace(workspaceId, (tx) =>
            tx.trackingToken.createMany({
                data: [
                    ...links.map((l) => ({
                        workspaceId,
                        outboundId: input.outboundId,
                        kind: 'click' as const,
                        tokenHash: hashToken(l.token),
                        url: l.url,
                    })),
                    {
                        workspaceId,
                        outboundId: input.outboundId,
                        kind: 'open' as const,
                        tokenHash: hashToken(open),
                        url: null,
                    },
                ],
            }),
        );
        const base = `https://${domain.domain}`;
        const short = new Map(links.map((l) => [l.url, `${base}/${TRACKING_CLICK_PATH}/${l.token}`]));
        return withOpenPixel(rewriteLinks(input.html, short), `${base}/${TRACKING_OPEN_PATH}/${open}`);
    }

    /**
     * A hit on a token of the kind. Answers the click's original URL (the redirect's target) or
     * `null` for an open; `404` for a token that is not one of this kind. The hit is recorded whoever
     * made it; a scanner's hit is kept with its reason and announced as nothing.
     */
    async hit(kind: TrackingKind, token: string, request: HitRequest): Promise<string | null> {
        const tokenHash = hashToken(token);
        const owner = await this.ownerPrisma.trackingToken.findUnique({
            where: { tokenHash },
            select: { workspaceId: true, kind: true },
        });
        if (!owner || owner.kind !== kind) throw new NotFoundException('not found');
        return this.rls.withWorkspace(owner.workspaceId, async (tx) => {
            const row = await tx.trackingToken.findUnique({
                where: { tokenHash },
                include: {
                    outbound: {
                        select: { personId: true, sequenceStepId: true, sequenceEnrolmentId: true, sentAt: true },
                    },
                },
            });
            if (!row || row.kind !== kind) throw new NotFoundException('not found');
            const reason = botReason({ userAgent: request.userAgent, sentAt: row.outbound.sentAt, at: request.at });
            await tx.trackingHit.create({
                data: {
                    workspaceId: owner.workspaceId,
                    tokenId: row.id,
                    outboundId: row.outboundId,
                    kind,
                    personId: row.outbound.personId,
                    sequenceStepId: row.outbound.sequenceStepId,
                    enrolmentId: row.outbound.sequenceEnrolmentId,
                    happenedAt: request.at,
                    userAgent: request.userAgent?.slice(0, 512) ?? null,
                    botReason: reason,
                },
            });
            if (reason === null) {
                const tracking: EmailTrackingPayload = {
                    outboundId: row.outboundId,
                    personId: row.outbound.personId,
                    url: row.url,
                    sequenceStepId: row.outbound.sequenceStepId,
                    enrolmentId: row.outbound.sequenceEnrolmentId,
                    indicative: kind === 'open',
                };
                const person = row.outbound.personId ? [{ type: 'person' as const, id: row.outbound.personId }] : [];
                const event: DomainEvent = {
                    type: kind === 'click' ? 'email.clicked' : 'email.opened',
                    object: 'email',
                    workspaceId: owner.workspaceId,
                    actor: { kind: 'system', id: null },
                    occurredAt: request.at.toISOString(),
                    recordId: row.outboundId,
                    related: person,
                    targets: person,
                    tracking,
                };
                await this.events.record(tx, event);
            }
            return row.url;
        });
    }
}

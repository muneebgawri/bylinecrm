import { Injectable, NotFoundException } from '@nestjs/common';
import {
    TRACKING_CLICK_PATH,
    TRACKING_OPEN_PATH,
    type DomainEvent,
    type EmailTrackingPayload,
} from '@bylinecrm/shared';
import type { Prisma, TrackingKind } from '@prisma/client';
import { hashToken, randomToken } from '../auth/tokens';
import { DomainEvents } from '../events/domain-events.service';
import { PrismaService } from '../infra/prisma.service';
import { RlsPrismaService, type WorkspaceClient } from '../infra/rls-prisma.service';
import { botReason } from './bots';
import { rewriteLinks, trackableLinks, withOpenPixel } from './link-rewriter';
import { TRACKING_TOKEN_BYTES } from './tracking.constants';
import { trackingRulesIn, type TrackingRules } from './tracking-policy.service';

/** TRACK-2: HTML rewritten for tracking, and the token rows it names, to be written with the send. */
export interface PlannedTracking {
    html: string;
    tokens: Prisma.TrackingTokenCreateManyInput[];
}

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
     * A sequence step's HTML with its links rewritten and the pixel added — as the workspace's policy says (TRACK-2:
     * opens and clicks each on or off) — or unchanged when the workspace has no verified short-link domain. A step sent
     * through an SMTP2Go pool mailbox while SMTP2Go is the workspace's provider goes as it is: SMTP2Go tracks it.
     * `exclude` names the links never rewritten (the unsubscribe link).
     */
    async trackOutreach(
        workspaceId: string,
        input: { outboundId: string; html: string; exclude: readonly string[]; viaSmtp2Go?: boolean },
    ): Promise<string> {
        const rules = await this.rls.withWorkspace(workspaceId, (tx) => trackingRulesIn(tx, workspaceId));
        if (input.viaSmtp2Go && rules.provider === 'smtp2go') return input.html;
        const planned = await this.plan(workspaceId, input, rules);
        if (planned.tokens.length > 0) {
            await this.rls.withWorkspace(workspaceId, (tx) => tx.trackingToken.createMany({ data: planned.tokens }));
        }
        return planned.html;
    }

    /**
     * TRACK-2: an email written in the CRM, tracked by our own links and pixel — called only for a send its writer
     * left tracked that goes through Gmail (one through the SMTP2Go relay is SMTP2Go's to track). The send's row does
     * not exist yet: its tokens are returned for the caller to write with it, in its transaction.
     */
    async trackPersonal(workspaceId: string, input: { outboundId: string; html: string }): Promise<PlannedTracking> {
        const rules = await this.rls.withWorkspace(workspaceId, (tx) => trackingRulesIn(tx, workspaceId));
        return this.plan(workspaceId, { ...input, exclude: [] }, rules);
    }

    /** The HTML rewritten as the rules say, and the tokens it names (not written). */
    private async plan(
        workspaceId: string,
        input: { outboundId: string; html: string; exclude: readonly string[] },
        rules: TrackingRules,
    ): Promise<PlannedTracking> {
        const none = { html: input.html, tokens: [] };
        if (!rules.trackOpens && !rules.trackClicks) return none;
        const domain = await this.rls.withWorkspace(workspaceId, (tx) =>
            tx.trackingDomain.findUnique({ where: { workspaceId }, select: { domain: true, status: true } }),
        );
        if (!domain || domain.status !== 'pass') return none;
        const links = (rules.trackClicks ? trackableLinks(input.html, input.exclude) : []).map((url) => ({
            url,
            token: randomToken(TRACKING_TOKEN_BYTES),
        }));
        const open = rules.trackOpens ? randomToken(TRACKING_TOKEN_BYTES) : null;
        const rows = [
            ...links.map((l) => ({
                workspaceId,
                outboundId: input.outboundId,
                kind: 'click' as const,
                tokenHash: hashToken(l.token),
                url: l.url,
            })),
            ...(open
                ? [
                      {
                          workspaceId,
                          outboundId: input.outboundId,
                          kind: 'open' as const,
                          tokenHash: hashToken(open),
                          url: null,
                      },
                  ]
                : []),
        ];
        if (rows.length === 0) return none;
        const base = `https://${domain.domain}`;
        const short = new Map(links.map((l) => [l.url, `${base}/${TRACKING_CLICK_PATH}/${l.token}`]));
        const rewritten = rewriteLinks(input.html, short);
        return {
            html: open ? withOpenPixel(rewritten, `${base}/${TRACKING_OPEN_PATH}/${open}`) : rewritten,
            tokens: rows,
        };
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
                await this.events.record(
                    tx,
                    hitEvent(owner.workspaceId, kind, row.outboundId, row.url, row.outbound, request.at),
                );
            }
            return row.url;
        });
    }

    /**
     * An open or click SMTP2Go reported for a send that went through it (TRANS-1), inside the webhook's
     * transaction: one `tracking_hits` row keyed by SMTP2Go's event (a redelivery writes nothing), judged by the
     * same scanner rule, and announced as `email.opened` / `email.clicked` exactly as our own hits are. A send
     * whose links are already ours (the workspace's short-link domain, P3-4) is counted by our hits only:
     * SMTP2Go's report of the same open or click is `ignored`, never counted twice.
     */
    async recordProviderHit(
        tx: WorkspaceClient,
        workspaceId: string,
        hit: {
            outboundId: string;
            kind: TrackingKind;
            url: string | null;
            userAgent: string | undefined;
            at: Date;
            providerEventId: string;
        },
    ): Promise<'recorded' | 'duplicate' | 'ignored'> {
        if ((await tx.trackingToken.count({ where: { outboundId: hit.outboundId } })) > 0) return 'ignored';
        const outbound = await tx.mailOutbound.findUniqueOrThrow({
            where: { id: hit.outboundId },
            select: { personId: true, sequenceStepId: true, sequenceEnrolmentId: true, sentAt: true },
        });
        const reason = botReason({ userAgent: hit.userAgent, sentAt: outbound.sentAt, at: hit.at });
        const url = hit.kind === 'click' ? hit.url : null;
        const written = await tx.trackingHit.createManyAndReturn({
            data: [
                {
                    workspaceId,
                    tokenId: null,
                    providerEventId: hit.providerEventId,
                    url,
                    outboundId: hit.outboundId,
                    kind: hit.kind,
                    personId: outbound.personId,
                    sequenceStepId: outbound.sequenceStepId,
                    enrolmentId: outbound.sequenceEnrolmentId,
                    happenedAt: hit.at,
                    userAgent: hit.userAgent?.slice(0, 512) ?? null,
                    botReason: reason,
                },
            ],
            skipDuplicates: true,
        });
        if (written.length === 0) return 'duplicate';
        if (reason === null) {
            await this.events.record(tx, hitEvent(workspaceId, hit.kind, hit.outboundId, url, outbound, hit.at));
        }
        return 'recorded';
    }
}

/** The `email.clicked` / `email.opened` a counted hit announces, whoever's tracking saw it. */
function hitEvent(
    workspaceId: string,
    kind: TrackingKind,
    outboundId: string,
    url: string | null,
    outbound: { personId: string | null; sequenceStepId: string | null; sequenceEnrolmentId: string | null },
    at: Date,
): DomainEvent {
    const tracking: EmailTrackingPayload = {
        outboundId,
        personId: outbound.personId,
        url,
        sequenceStepId: outbound.sequenceStepId,
        enrolmentId: outbound.sequenceEnrolmentId,
        indicative: kind === 'open',
    };
    const person = outbound.personId ? [{ type: 'person' as const, id: outbound.personId }] : [];
    return {
        type: kind === 'click' ? 'email.clicked' : 'email.opened',
        object: 'email',
        workspaceId,
        actor: { kind: 'system', id: null },
        occurredAt: at.toISOString(),
        recordId: outboundId,
        related: person,
        targets: person,
        tracking,
    };
}

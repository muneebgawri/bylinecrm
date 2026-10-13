import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { UNSUBSCRIBE_API_PATH, UNSUBSCRIBE_PAGE_PATH, normaliseEmail } from '@bylinecrm/shared';
import { hashToken, randomToken } from '../auth/tokens';
import { ENV, type Env } from '../config/env';
import { PrismaService } from '../infra/prisma.service';
import { RlsPrismaService } from '../infra/rls-prisma.service';
import type { UnsubscribeStatusView } from './responses';
import { UNSUBSCRIBE_TOKEN_BYTES } from './suppression.constants';
import { SuppressionService } from './suppression.service';

/** One recipient's unsubscribe link for one message. */
export interface UnsubscribeLink {
    /** The secret; only its hash is stored. */
    token: string;
    /** What `List-Unsubscribe` names: the API route a mail client POSTs to (RFC 8058). */
    oneClickUrl: string;
    /** What the visible link opens: the confirmation page. */
    pageUrl: string;
}

/**
 * Unsubscribe links (P3-1, FR-CRMS-7). `issue` makes one per (workspace, recipient, message) when an
 * outreach message is built; the public routes resolve a token to its workspace and address and
 * unsubscribe it there — the workspace always comes from the token's row, never from the request.
 *
 * A token is 256 random bits, stored only as its SHA-256; it names nothing. Tokens do not expire:
 * an unsubscribe link has to keep working, and a used one is harmless to use again.
 */
@Injectable()
export class UnsubscribeService {
    constructor(
        @Inject(ENV) private readonly env: Env,
        private readonly rls: RlsPrismaService,
        // The public route has no workspace until the token names one: the owner client reads that
        // one column by hash, as invitation acceptance does. Everything after runs under RLS.
        private readonly ownerPrisma: PrismaService,
        private readonly suppressions: SuppressionService,
    ) {}

    async issue(
        workspaceId: string,
        input: { address: string; personId: string | null; outboundId: string | null },
    ): Promise<UnsubscribeLink> {
        const address = normaliseEmail(input.address);
        if (!address) throw new Error(`issue: not an email address`);
        const token = randomToken(UNSUBSCRIBE_TOKEN_BYTES);
        await this.rls.withWorkspace(workspaceId, (tx) =>
            tx.unsubscribeToken.create({
                data: {
                    workspaceId,
                    tokenHash: hashToken(token),
                    address,
                    personId: input.personId,
                    outboundId: input.outboundId,
                },
            }),
        );
        return {
            token,
            oneClickUrl: `${trimSlash(this.env.APP_URL)}${UNSUBSCRIBE_API_PATH}/${token}`,
            pageUrl: this.pageUrl(token),
        };
    }

    /** Where a GET of the one-click URL leads: the confirmation page. `404` for a token that does not exist. */
    async page(token: string): Promise<string> {
        await this.resolve(token);
        return this.pageUrl(token);
    }

    /** What the confirmation page shows: the masked address, and whether it is unsubscribed already. */
    async status(token: string): Promise<UnsubscribeStatusView> {
        const link = await this.resolve(token);
        const live = await this.suppressions.check(link.workspaceId, [link.address]);
        return { recipient: maskAddress(link.address), unsubscribed: live.has(link.address) };
    }

    /**
     * Unsubscribes the token's address in the token's workspace (reason `unsubscribe`, source
     * `recipient`). Idempotent: an address already suppressed keeps its entry and the answer is the same.
     */
    async unsubscribe(token: string): Promise<UnsubscribeStatusView> {
        const link = await this.resolve(token);
        await this.suppressions.suppress(link.workspaceId, {
            address: link.address,
            reason: 'unsubscribe',
            source: 'recipient',
            personId: link.personId,
            outboundId: link.outboundId,
        });
        await this.rls.withWorkspace(link.workspaceId, (tx) =>
            tx.unsubscribeToken.update({ where: { id: link.id }, data: { usedAt: new Date() } }),
        );
        return { recipient: maskAddress(link.address), unsubscribed: true };
    }

    private async resolve(token: string) {
        const tokenHash = hashToken(token);
        const owner = await this.ownerPrisma.unsubscribeToken.findUnique({
            where: { tokenHash },
            select: { workspaceId: true },
        });
        if (!owner) throw new NotFoundException('unsubscribe link not found');
        const link = await this.rls.withWorkspace(owner.workspaceId, (tx) =>
            tx.unsubscribeToken.findUnique({ where: { tokenHash } }),
        );
        if (!link) throw new NotFoundException('unsubscribe link not found');
        return link;
    }

    private pageUrl(token: string): string {
        return `${trimSlash(this.env.WEB_URL)}${UNSUBSCRIBE_PAGE_PATH}/${token}`;
    }
}

/** `dana@acme.example` → `d•••@acme.example`: enough for the person to recognise, nothing for a leaked link. */
export function maskAddress(address: string): string {
    const at = address.lastIndexOf('@');
    return `${address.slice(0, 1)}•••${address.slice(at)}`;
}

function trimSlash(url: string): string {
    return url.replace(/\/+$/, '');
}

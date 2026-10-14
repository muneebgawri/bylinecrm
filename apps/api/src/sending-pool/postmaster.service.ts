import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
    POSTMASTER_SCOPES,
    type PostmasterConnectionView,
    type PostmasterDomainStatus,
    type SendingDomainSpamRate,
} from '@bylinecrm/shared';
import type { Prisma } from '@prisma/client';
import { RedisService } from '../infra/redis.service';
import { RlsPrismaService, type WorkspaceClient } from '../infra/rls-prisma.service';
import { SecretBox } from '../infra/secret-box';
import { WorkspaceContext } from '../infra/workspace-context';
import { GOOGLE_OAUTH_PORT, GoogleOAuthError, type GoogleOAuthPort } from '../mail-accounts/google-oauth.port';
import { TOKEN_REFRESH_SKEW_S } from '../mail-accounts/mail-accounts.constants';
import { OAuthClientsService } from '../mail-accounts/oauth-clients.service';
import { assessGrant } from '../mail-accounts/oauth-flow';
import { tokenUnderLock } from '../mail-accounts/token-lock';
import { postmasterConnectionView } from './postmaster-connection';
import { postmasterDay } from './postmaster.http';
import { POSTMASTER_PORT, PostmasterRequestFailed, type PostmasterPort } from './postmaster.port';
import { POSTMASTER_TOKEN_LOCK_KEY_PREFIX } from './sending-pool.constants';

type ConnectionRow = Prisma.PostmasterConnectionGetPayload<object>;

/**
 * What one check learned from Postmaster Tools about a domain: what to store on the domain, the
 * day's rate when it gave one, and — after a rate limit (#183) — how long Google asked to wait.
 */
export interface PostmasterReading {
    status: PostmasterDomainStatus;
    message: string | null;
    rate: SendingDomainSpamRate | null;
    retryAfterS?: number | null;
}

/** The connection cannot be used until an admin connects it again (Google refused the grant). */
class PostmasterReconnectNeeded extends Error {
    constructor(readonly reason: string) {
        super(reason);
        this.name = 'PostmasterReconnectNeeded';
    }
}

/**
 * The workspace's Postmaster Tools connection (P3-2b, #129, FR-CRMS-13): reading a sending
 * domain's user-reported spam rate for the domain check (`read`, never inside a transaction),
 * refreshing the grant like a mailbox's — one process at a time, through the workspace's own
 * client — and disconnecting it. Connecting runs through the mailbox connect flow (mail accounts)
 * with Postmaster's scopes; the one-time Google-side setup is in docs/design-notes/P3-2.md.
 */
@Injectable()
export class PostmasterService {
    private readonly logger = new Logger(PostmasterService.name);

    constructor(
        private readonly rls: RlsPrismaService,
        private readonly context: WorkspaceContext,
        private readonly secrets: SecretBox,
        private readonly redis: RedisService,
        private readonly clients: OAuthClientsService,
        @Inject(GOOGLE_OAUTH_PORT) private readonly google: GoogleOAuthPort,
        @Inject(POSTMASTER_PORT) private readonly postmaster: PostmasterPort,
    ) {}

    /** The connection as the pool view shows it, or null while none is. */
    async viewIn(tx: WorkspaceClient): Promise<PostmasterConnectionView | null> {
        const row = await tx.postmasterConnection.findFirst();
        return row ? postmasterConnectionView(row) : null;
    }

    /**
     * Yesterday's user-reported spam rate for the domain, as the domain check asks for it. Never
     * throws for what Google says: no connection, a domain the account has not verified, a rate
     * limit (#183), no answer, a refused request or a refused grant each become a reading the
     * domain records and the pool shows. Only a refusal is a warning; a limit and no answer are
     * transient, and the last reading stands.
     */
    async read(workspaceId: string, domain: string, now = new Date()): Promise<PostmasterReading> {
        const connection = await this.rls.withWorkspace(workspaceId, (tx) => tx.postmasterConnection.findFirst());
        if (!connection) return { status: 'not_connected', message: null, rate: null };
        const day = postmasterDay(now);
        try {
            const token = await this.accessToken(workspaceId);
            const lookup = await this.postmaster.trafficStats(token, domain, day);
            if (lookup.status === 'not_verified') {
                return {
                    status: 'not_verified',
                    message: `${domain} is not verified in Postmaster Tools for ${connection.email}`,
                    rate: null,
                };
            }
            if (lookup.status === 'rate_limited') {
                return {
                    status: 'rate_limited',
                    message: 'Postmaster Tools is rate-limiting reads',
                    rate: null,
                    retryAfterS: lookup.retryAfterS,
                };
            }
            if (lookup.status === 'no_data' || lookup.spamRateBps === null) {
                return { status: 'ok', message: `no data for ${day}: too little traffic to report`, rate: null };
            }
            return { status: 'ok', message: null, rate: { day: lookup.day, rateBps: lookup.spamRateBps } };
        } catch (error) {
            if (error instanceof PostmasterRequestFailed) {
                // No answer, or a server-side failure, passes on its own; a 4xx will not.
                const transient = error.status === 0 || error.status >= 500;
                return { status: transient ? 'unreachable' : 'failed', message: error.message, rate: null };
            }
            if (error instanceof PostmasterReconnectNeeded) {
                return { status: 'failed', message: error.reason, rate: null };
            }
            throw error;
        }
    }

    /** An admin disconnects it: the grant is revoked at Google (best effort) and the row goes. Nothing stays. */
    async remove(): Promise<void> {
        const context = this.context.get();
        if (!context) throw new Error('PostmasterService.remove is used inside a workspace scope');
        const row = await this.rls.withWorkspace((tx) => tx.postmasterConnection.findFirst());
        if (!row) throw new NotFoundException('no Postmaster Tools account is connected');
        try {
            await this.google.revoke(this.secrets.open(row.refreshTokenCiphertext));
        } catch (error) {
            if (!(error instanceof GoogleOAuthError)) throw error;
            this.logger.warn(
                `Postmaster connection in ${context.workspaceId}: revoke not confirmed by Google (${error.error})`,
            );
        }
        await this.rls.withWorkspace((tx) =>
            tx.postmasterConnection.delete({ where: { workspaceId: row.workspaceId } }),
        );
    }

    // ── Internals ────────────────────────────────────────────────────────────────────────────

    /** A usable access token, refreshed through the workspace's client when due; one refresh at a time. */
    private accessToken(workspaceId: string): Promise<string> {
        return tokenUnderLock(
            this.redis,
            `${POSTMASTER_TOKEN_LOCK_KEY_PREFIX}${workspaceId}`,
            async () => this.freshToken(await this.row(workspaceId)),
            () => this.refresh(workspaceId),
        );
    }

    private async refresh(workspaceId: string): Promise<string> {
        const row = await this.row(workspaceId);
        const fresh = this.freshToken(row);
        if (fresh) return fresh;
        const client = await this.rls.withWorkspace(workspaceId, (tx) => this.clients.storedIn(tx));
        if (!client)
            throw await this.markReconnectNeeded(
                workspaceId,
                'the workspace has no Google OAuth client to refresh through',
            );
        let grant;
        try {
            grant = await this.google.refresh(client, this.secrets.open(row.refreshTokenCiphertext));
        } catch (error) {
            if (error instanceof GoogleOAuthError && error.error === 'invalid_grant') {
                throw await this.markReconnectNeeded(
                    workspaceId,
                    'Google no longer accepts the Postmaster Tools connection; connect it again',
                );
            }
            throw error;
        }
        if (grant.scopes.length > 0) {
            const assessment = assessGrant(grant.scopes, POSTMASTER_SCOPES);
            if (!assessment.ok) throw await this.markReconnectNeeded(workspaceId, assessment.detail);
        }
        await this.rls.withWorkspace(workspaceId, (tx) =>
            tx.postmasterConnection.update({
                where: { workspaceId },
                data: {
                    accessTokenCiphertext: this.secrets.seal(grant.accessToken),
                    accessExpiresAt: new Date(Date.now() + grant.expiresInS * 1000),
                    ...(grant.refreshToken ? { refreshTokenCiphertext: this.secrets.seal(grant.refreshToken) } : {}),
                    ...(grant.scopes.length > 0 ? { grantedScopes: grant.scopes } : {}),
                },
            }),
        );
        return grant.accessToken;
    }

    private async markReconnectNeeded(workspaceId: string, reason: string): Promise<PostmasterReconnectNeeded> {
        await this.rls.withWorkspace(workspaceId, (tx) =>
            tx.postmasterConnection.updateMany({
                where: { workspaceId },
                data: { status: 'reconnect_needed', lastError: reason },
            }),
        );
        return new PostmasterReconnectNeeded(reason);
    }

    private async row(workspaceId: string): Promise<ConnectionRow> {
        const row = await this.rls.withWorkspace(workspaceId, (tx) => tx.postmasterConnection.findFirst());
        if (!row) throw new PostmasterReconnectNeeded('no Postmaster Tools account is connected');
        if (row.status !== 'connected')
            throw new PostmasterReconnectNeeded(row.lastError ?? 'the connection needs reconnecting');
        return row;
    }

    /** The stored access token if it is valid for longer than the skew; otherwise nothing. */
    private freshToken(row: ConnectionRow): string | null {
        if (row.accessExpiresAt.getTime() - Date.now() <= TOKEN_REFRESH_SKEW_S * 1000) return null;
        return this.secrets.open(row.accessTokenCiphertext);
    }
}

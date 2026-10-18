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
import { postmasterRange } from './postmaster.http';
import {
    describeGoogleError,
    POSTMASTER_PORT,
    PostmasterRequestFailed,
    type PostmasterDomain,
    type PostmasterPort,
} from './postmaster.port';
import { POSTMASTER_TOKEN_LOCK_KEY_PREFIX } from './sending-pool.constants';

type ConnectionRow = Prisma.PostmasterConnectionGetPayload<object>;

/**
 * What one check learned from Postmaster Tools about a domain: what to store on the domain, every
 * day's rate it gave over the range asked (#190), yesterday's — the one a pause is judged on — when
 * it gave one, and — after a rate limit or a spent quota (#183, #190) — how long Google asked to wait.
 */
export interface PostmasterReading {
    status: PostmasterDomainStatus;
    message: string | null;
    rate: SendingDomainSpamRate | null;
    history: SendingDomainSpamRate[];
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
 * The workspace's Postmaster Tools connection (P3-2b, #129, #190, FR-CRMS-13): reading a sending
 * domain's user-reported spam rates for the domain check (`read`) and the account's domains for
 * the daily listing (`domains`), never inside a transaction; refreshing the grant like a mailbox's — one process at a time, through the workspace's own
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
     * The domain's user-reported spam rates over the last 30 days, yesterday's among them, as the
     * domain check asks for them. Never throws for what Google says: no connection, a grant made
     * before v2 (#190), a domain the account has not verified, a rate limit (#183), a spent quota
     * (#190), no answer, a refused request or a refused grant each become a reading the domain
     * records and the pool shows — with Google's own status and message when it gave them, which
     * are logged too (never the token). A limit and no answer are transient, and the last reading
     * stands; a spent quota is an admin's to raise.
     */
    async read(workspaceId: string, domain: string, now = new Date()): Promise<PostmasterReading> {
        const connection = await this.rls.withWorkspace(workspaceId, (tx) => tx.postmasterConnection.findFirst());
        if (!connection) return { status: 'not_connected', message: null, rate: null, history: [] };
        const { from, to } = postmasterRange(now);
        try {
            const token = await this.accessToken(workspaceId);
            const lookup = await this.postmaster.spamRates(token, domain, from, to);
            if (lookup.status === 'not_verified') {
                const said = describeGoogleError(lookup.google);
                return {
                    status: 'not_verified',
                    message: `${domain} is not verified in Postmaster Tools for ${connection.email}${said ? ` (Google: ${said})` : ''}`,
                    rate: null,
                    history: [],
                };
            }
            if (lookup.status === 'rate_limited' || lookup.status === 'quota_exhausted') {
                const said = describeGoogleError(lookup.google);
                const message =
                    lookup.status === 'quota_exhausted'
                        ? `Google’s Postmaster Tools API quota is used up (${said}): raise the Postmaster Tools API quota in Google Cloud`
                        : `Postmaster Tools is rate-limiting reads${said ? ` (Google: ${said})` : ''}`;
                this.logger.warn(
                    `Postmaster Tools answered 429 for ${domain} in ${workspaceId}: ${said ?? 'no error body'}`,
                );
                return { status: lookup.status, message, rate: null, history: [], retryAfterS: lookup.retryAfterS };
            }
            const history = lookup.rates.map((r) => ({ day: r.day, rateBps: r.spamRateBps }));
            const rate = history.find((r) => r.day === to) ?? null;
            return {
                status: 'ok',
                message: rate
                    ? null
                    : `no data for ${to}: Postmaster Tools reports only domains with substantial Gmail-bound traffic`,
                rate,
                history,
            };
        } catch (error) {
            if (error instanceof PostmasterRequestFailed) {
                this.logger.warn(`${error.message} (in ${workspaceId})`);
                // No answer, or a server-side failure, passes on its own; a 4xx will not.
                const transient = error.status === 0 || error.status >= 500;
                return {
                    status: transient ? 'unreachable' : 'failed',
                    message: error.message,
                    rate: null,
                    history: [],
                };
            }
            if (error instanceof PostmasterReconnectNeeded) {
                return { status: 'failed', message: error.reason, rate: null, history: [] };
            }
            throw error;
        }
    }

    /**
     * Every domain the connected account holds in Postmaster Tools (#190), for the daily listing; null
     * when nothing is connected or the connection needs reconnecting. Throws `PostmasterRequestFailed`
     * when Google did not answer, which the listing logs and tries again later.
     */
    async domains(workspaceId: string): Promise<PostmasterDomain[] | null> {
        try {
            return await this.postmaster.domains(await this.accessToken(workspaceId));
        } catch (error) {
            if (error instanceof PostmasterReconnectNeeded) return null;
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
        // Nothing is listed once nothing is connected (#190); the domains and their history stay.
        await this.rls.withWorkspace(async (tx) => {
            await tx.postmasterConnection.delete({ where: { workspaceId: row.workspaceId } });
            await tx.sendingDomain.updateMany({ where: { inPostmaster: true }, data: { inPostmaster: false } });
        });
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
        // A grant made for v1 (`postmaster.readonly`) is not accepted by v2 (#190): it is connected again.
        const assessment = assessGrant(row.grantedScopes, POSTMASTER_SCOPES);
        if (!assessment.ok) {
            throw await this.markReconnectNeeded(
                workspaceId,
                `the Postmaster Tools API v2 needs access this grant does not hold (${assessment.detail}): connect Postmaster Tools again`,
            );
        }
        return row;
    }

    /** The stored access token if it is valid for longer than the skew; otherwise nothing. */
    private freshToken(row: ConnectionRow): string | null {
        if (row.accessExpiresAt.getTime() - Date.now() <= TOKEN_REFRESH_SKEW_S * 1000) return null;
        return this.secrets.open(row.accessTokenCiphertext);
    }
}

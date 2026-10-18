import { Inject, Injectable, Logger } from '@nestjs/common';
import {
    GMAIL_SCOPES,
    MAILBOX_PURPOSES,
    PERSONAL_MAILBOX_SCOPES,
    POSTMASTER_SCOPES,
    type MailboxConnectResult,
    type MailboxPurpose,
} from '@bylinecrm/shared';
import { Prisma } from '@prisma/client';
import { DomainEvents } from '../events/domain-events.service';
import { ApiException } from '../infra/errors/api-errors';
import { RedisService } from '../infra/redis.service';
import { actorOf } from '../records/actor';
import { RlsPrismaService, type WorkspaceClient } from '../infra/rls-prisma.service';
import { SecretBox } from '../infra/secret-box';
import { WorkspaceContext, type WorkspaceRunContext } from '../infra/workspace-context';
import { enrolMailbox } from '../sending-pool/pool-mailbox';
import { storePostmasterConnection } from '../sending-pool/postmaster-connection';
import { MembershipService } from '../workspace/membership.service';
import { RolesService } from '../workspace/roles.service';
import { GOOGLE_OAUTH_PORT, GoogleOAuthError, type GoogleOAuthPort, type TokenGrant } from './google-oauth.port';
import { CONNECT_STATE_KEY_PREFIX, CONNECT_STATE_TTL_S } from './mail-accounts.constants';
import { MailboxTokens, MailboxUnavailable, type MailboxErrorRecord } from './mailbox-tokens.service';
import { OAuthClientsService } from './oauth-clients.service';
import { assessGrant, authorizeUrl, codeChallengeS256, randomToken } from './oauth-flow';
import type { ConnectStart, MailboxCheck, MailboxDisconnected, MailboxView } from './responses';

type MailboxRow = Prisma.MailboxGetPayload<object>;

/**
 * What a connect is for: a mailbox (personal or pool), or the workspace's Postmaster Tools account
 * (#129) — the same flow through the same client, asking for Postmaster's scopes instead of Gmail's.
 */
export type ConnectPurpose = MailboxPurpose | 'postmaster';
const CONNECT_PURPOSES: readonly ConnectPurpose[] = [...MAILBOX_PURPOSES, 'postmaster'];

/** A connect request, kept server-side until Google calls back. Never sent to the browser. */
interface PendingConnect {
    workspaceId: string;
    memberId: string;
    userId: string;
    purpose: ConnectPurpose;
    codeVerifier: string;
    /** The client the request was made through; a client changed mid-flow ends the request. */
    clientRowId: string;
}

/** How a callback ended: where to send the browser, the one code it carries, and what the connect was for. */
export interface ConnectOutcome {
    workspaceId: string | null;
    result: MailboxConnectResult;
    purpose: ConnectPurpose | null;
}

/**
 * Mailboxes (P2-1, FR-CRMS-1): connecting one through the workspace's own OAuth client with the
 * two narrow scopes, seeing them, labelling, checking and disconnecting them. Who sees what (with
 * `mailbox:read`): an admin sees every mailbox; a member sees their own and the sending pool.
 * Changing or disconnecting a mailbox is its owner's or an admin's.
 */
@Injectable()
export class MailboxesService {
    private readonly logger = new Logger(MailboxesService.name);

    constructor(
        private readonly rls: RlsPrismaService,
        private readonly context: WorkspaceContext,
        private readonly secrets: SecretBox,
        private readonly redis: RedisService,
        private readonly clients: OAuthClientsService,
        private readonly tokens: MailboxTokens,
        private readonly memberships: MembershipService,
        private readonly roles: RolesService,
        private readonly events: DomainEvents,
        @Inject(GOOGLE_OAUTH_PORT) private readonly google: GoogleOAuthPort,
    ) {}

    // ── Reading ──────────────────────────────────────────────────────────────────────────────

    list(): Promise<MailboxView[]> {
        const context = this.current();
        return this.rls.withWorkspace(async (tx) => {
            const rows = await tx.mailbox.findMany({ where: visibleTo(context), orderBy: { createdAt: 'asc' } });
            return rows.map(view);
        });
    }

    get(id: string): Promise<MailboxView> {
        const context = this.current();
        return this.rls.withWorkspace(async (tx) => view(await this.visible(tx, context, id)));
    }

    /**
     * The mailbox if the caller may act on it (its owner or an admin): `404` if they cannot see it,
     * `403` if they see it but it is not theirs. For routes about a mailbox that live elsewhere
     * (P2-2's sync trigger), so the rule stays this one.
     */
    assertChangeable(id: string): Promise<MailboxView> {
        const context = this.current();
        return this.rls.withWorkspace(async (tx) => view(await this.changeable(tx, context, id)));
    }

    // ── Changing ─────────────────────────────────────────────────────────────────────────────

    /** The label only. A different purpose is refused: it is fixed when the mailbox connects. */
    update(
        id: string,
        patch: { label?: string | null | undefined; purpose?: MailboxPurpose | undefined },
    ): Promise<MailboxView> {
        const context = this.current();
        return this.rls.withWorkspace(async (tx) => {
            const row = await this.changeable(tx, context, id);
            if (patch.purpose !== undefined && patch.purpose !== row.purpose) {
                throw new ApiException(
                    409,
                    'conflict',
                    "a mailbox's purpose is fixed when it connects; disconnect it and connect it again for the other purpose",
                );
            }
            if (patch.label === undefined || patch.label === row.label) return view(row);
            return view(await tx.mailbox.update({ where: { id }, data: { label: patch.label } }));
        });
    }

    /**
     * Revokes the grant at Google, wipes the stored tokens and marks the mailbox disconnected.
     * The tokens go whether or not Google confirms the revocation; `revoked` says which.
     */
    async disconnect(id: string): Promise<MailboxDisconnected> {
        const context = this.current();
        const row = await this.rls.withWorkspace((tx) => this.changeable(tx, context, id));
        if (row.status === 'disconnected') return { mailbox: view(row), revoked: false };

        let revoked = false;
        if (row.refreshTokenCiphertext) {
            try {
                await this.google.revoke(this.secrets.open(row.refreshTokenCiphertext));
                revoked = true;
            } catch (error) {
                if (!(error instanceof GoogleOAuthError)) throw error;
                // The tokens are wiped below regardless; Google keeps the grant until its owner
                // removes it in their account, and nothing here can use it any more.
                this.logger.warn(`mailbox ${row.id}: revoke not confirmed by Google (${error.error})`);
            }
        }
        const after = await this.rls.withWorkspace(async (tx) => {
            const disconnected = await tx.mailbox.update({
                where: { id },
                data: {
                    status: 'disconnected',
                    refreshTokenCiphertext: null,
                    accessTokenCiphertext: null,
                    accessExpiresAt: null,
                    lastError: Prisma.DbNull,
                },
            });
            await this.events.record(tx, {
                type: 'mailbox.disconnected',
                object: 'mailbox',
                workspaceId: context.workspaceId,
                actor: actorOf(context),
                occurredAt: new Date().toISOString(),
                recordId: id,
            });
            return disconnected;
        });
        return { mailbox: view(after), revoked };
    }

    /**
     * Probes the mailbox: a usable token (refreshed if due) and the scopes Google says it carries.
     * A grant Google refuses or a scope withdrawn moves the mailbox to `reconnect_needed`.
     */
    async check(id: string): Promise<MailboxCheck> {
        const context = this.current();
        const row = await this.rls.withWorkspace((tx) => this.changeable(tx, context, id));
        if (row.status === 'disconnected') {
            throw new ApiException(409, 'conflict', 'the mailbox is disconnected; connect it again to check it');
        }
        let problem: MailboxCheck['problem'] = null;
        try {
            const accessToken = await this.tokens.getAccessToken(context.workspaceId, id);
            const scopes = await this.google.grantedScopes(accessToken);
            const assessment = assessGrant(scopes);
            if (assessment.ok) {
                await this.rls.withWorkspace((tx) =>
                    tx.mailbox.update({ where: { id }, data: { grantedScopes: scopes } }),
                );
            } else {
                problem = assessment.result === 'scope_too_broad' ? 'scope_too_broad' : 'scope_missing';
                await this.tokens.markReconnectNeeded(
                    context.workspaceId,
                    id,
                    { code: assessment.result, message: assessment.detail },
                    actorOf(context),
                );
            }
        } catch (error) {
            if (!(error instanceof MailboxUnavailable)) throw error;
            problem = 'reconnect_needed';
        }
        const after = await this.rls.withWorkspace((tx) => this.visible(tx, context, id));
        return { mailbox: view(after), ok: problem === null, problem };
    }

    // ── Connecting ───────────────────────────────────────────────────────────────────────────

    /**
     * Starts a connect: a server-side request (state, PKCE verifier, who, what for) and the Google
     * URL to send the browser to. A member connects a mailbox for themselves (or, an admin, the
     * workspace's Postmaster Tools account); an API key cannot.
     */
    async startConnect(purpose: ConnectPurpose): Promise<ConnectStart> {
        const context = this.current();
        if (!context.memberId || !context.userId) {
            throw new ApiException(
                403,
                'forbidden',
                'a connection is made by a member signing in to Google, not by an API key',
            );
        }
        const client = await this.rls.withWorkspace((tx) => this.clients.storedIn(tx));
        if (!client) {
            throw new ApiException(409, 'conflict', 'no Google OAuth client is configured; an admin sets one up first');
        }
        const state = randomToken();
        const codeVerifier = randomToken();
        const pending: PendingConnect = {
            workspaceId: context.workspaceId,
            memberId: context.memberId,
            userId: context.userId,
            purpose,
            codeVerifier,
            clientRowId: client.rowId,
        };
        await this.redis.ensureReady();
        await this.redis.set(`${CONNECT_STATE_KEY_PREFIX}${state}`, JSON.stringify(pending), 'EX', CONNECT_STATE_TTL_S);
        return {
            authorizeUrl: authorizeUrl({
                clientId: client.clientId,
                redirectUri: this.clients.redirectUri(),
                state,
                codeChallenge: codeChallengeS256(codeVerifier),
                scopes: scopesFor(purpose),
            }).toString(),
            expiresAt: new Date(Date.now() + CONNECT_STATE_TTL_S * 1000),
        };
    }

    /**
     * Finishes a connect from Google's callback. The request is taken once (read and deleted); it
     * must be finished by the person who started it, signed in now, who may still connect
     * mailboxes in that workspace — so a consent link cannot be used to land someone else's
     * mailbox in an attacker's workspace. Nothing is stored unless every check passes; a refused
     * grant is not revoked, because a revocation ends every token that Google account gave this
     * client — including a live connection of the same mailbox.
     */
    async finishConnect(
        callerUserId: string | null,
        query: { state?: string | undefined; code?: string | undefined; error?: string | undefined },
    ): Promise<ConnectOutcome> {
        const pending = query.state ? await this.takePending(query.state) : null;
        if (!pending) return { workspaceId: null, result: 'invalid_state', purpose: null };
        const workspaceId = pending.workspaceId;
        const end = (result: MailboxConnectResult): ConnectOutcome => ({
            workspaceId,
            result,
            purpose: pending.purpose,
        });

        if (query.error || !query.code) return end('denied');
        if (callerUserId !== pending.userId) return end('wrong_user');
        if (!(await this.mayStillConnect(pending))) return end('not_permitted');

        const client = await this.rls.withWorkspace(workspaceId, (tx) => this.clients.storedIn(tx));
        if (!client || client.rowId !== pending.clientRowId) return end('no_client');

        let grant: TokenGrant;
        let address: string;
        try {
            grant = await this.google.exchangeCode(client, {
                code: query.code,
                codeVerifier: pending.codeVerifier,
                redirectUri: this.clients.redirectUri(),
            });
        } catch (error) {
            if (!(error instanceof GoogleOAuthError)) throw error;
            this.logger.warn(`connect in workspace ${workspaceId}: code exchange refused (${error.error})`);
            return end('exchange_failed');
        }
        if (pending.purpose === 'postmaster') return end(await this.finishPostmaster(pending, client.rowId, grant));
        const purpose: MailboxPurpose = pending.purpose;
        const assessment = assessGrant(grant.scopes);
        if (!assessment.ok) return end(assessment.result);
        if (!grant.refreshToken) return end('no_refresh_token');
        try {
            address = (await this.google.mailboxAddress(grant.accessToken)).toLowerCase();
        } catch (error) {
            if (!(error instanceof GoogleOAuthError)) throw error;
            this.logger.warn(`connect in workspace ${workspaceId}: profile read refused (${error.error})`);
            return end('exchange_failed');
        }

        const refreshToken = grant.refreshToken;
        const outcome = await this.rls.withWorkspace(workspaceId, async (tx) => {
            const existing = await tx.mailbox.findUnique({
                where: { workspaceId_email: { workspaceId, email: address } },
            });
            if (existing && existing.status !== 'disconnected') {
                if (existing.ownerMemberId !== pending.memberId) return { result: 'owned_by_another' as const };
                if (existing.purpose !== purpose) return { result: 'purpose_mismatch' as const };
            }
            const tokens = {
                status: 'connected' as const,
                grantedScopes: grant.scopes,
                refreshTokenCiphertext: this.secrets.seal(refreshToken),
                accessTokenCiphertext: this.secrets.seal(grant.accessToken),
                accessExpiresAt: new Date(Date.now() + grant.expiresInS * 1000),
                lastError: Prisma.DbNull,
                connectedAt: new Date(),
            };
            const row = existing
                ? await tx.mailbox.update({
                      where: { id: existing.id },
                      // A disconnected mailbox connects afresh: owner and purpose are the new connection's.
                      data: { ...tokens, ownerMemberId: pending.memberId, purpose },
                  })
                : await tx.mailbox.create({
                      data: {
                          ...tokens,
                          workspaceId,
                          ownerMemberId: pending.memberId,
                          email: address,
                          purpose,
                      },
                  });
            await enrolMailbox(tx, row);
            await this.clients.markVerifiedIn(tx, client.rowId);
            await this.events.record(tx, {
                type: 'mailbox.connected',
                object: 'mailbox',
                workspaceId,
                actor: { kind: 'member', id: pending.memberId },
                occurredAt: new Date().toISOString(),
                recordId: row.id,
            });
            return { result: 'connected' as const };
        });
        if (outcome.result !== 'connected') return end(outcome.result);
        return end('connected');
    }

    /**
     * The Postmaster Tools account (#129): the grant must carry Postmaster's scopes and a refresh
     * token; the account's address comes from userinfo (a Postmaster grant has no Gmail scope).
     * One connection per workspace — connecting again replaces it.
     */
    private async finishPostmaster(
        pending: PendingConnect,
        clientRowId: string,
        grant: TokenGrant,
    ): Promise<MailboxConnectResult> {
        const assessment = assessGrant(grant.scopes, POSTMASTER_SCOPES);
        if (!assessment.ok) return assessment.result;
        if (!grant.refreshToken) return 'no_refresh_token';
        let email: string;
        try {
            email = (await this.google.accountEmail(grant.accessToken)).toLowerCase();
        } catch (error) {
            if (!(error instanceof GoogleOAuthError)) throw error;
            this.logger.warn(
                `Postmaster connect in workspace ${pending.workspaceId}: account read refused (${error.error})`,
            );
            return 'exchange_failed';
        }
        const refreshToken = grant.refreshToken;
        await this.rls.withWorkspace(pending.workspaceId, async (tx) => {
            await storePostmasterConnection(tx, {
                workspaceId: pending.workspaceId,
                email,
                grantedScopes: grant.scopes,
                refreshTokenCiphertext: this.secrets.seal(refreshToken),
                accessTokenCiphertext: this.secrets.seal(grant.accessToken),
                accessExpiresAt: new Date(Date.now() + grant.expiresInS * 1000),
                connectedByMemberId: pending.memberId,
            });
            await this.clients.markVerifiedIn(tx, clientRowId);
        });
        return 'connected';
    }

    // ── Internals ────────────────────────────────────────────────────────────────────────────

    /** Reads and deletes a pending request in one step: a state is accepted once. */
    private async takePending(state: string): Promise<PendingConnect | null> {
        await this.redis.ensureReady();
        const raw = await this.redis.getdel(`${CONNECT_STATE_KEY_PREFIX}${state}`);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as PendingConnect;
        return CONNECT_PURPOSES.includes(parsed.purpose) ? parsed : null;
    }

    /**
     * The member who started the connect is still a member and may still do what they started: a
     * mailbox takes `mailbox:manage`; the Postmaster Tools account is an admin's.
     */
    private async mayStillConnect(pending: PendingConnect): Promise<boolean> {
        const membership = await this.memberships.find(pending.userId, pending.workspaceId);
        if (!membership || membership.memberId !== pending.memberId) return false;
        const access = await this.roles.access(pending.workspaceId, membership.roleId);
        return (
            access?.capabilities.has(pending.purpose === 'postmaster' ? 'workspace:admin' : 'mailbox:manage') ?? false
        );
    }

    /** The mailbox if the caller may see it; otherwise `404`, never a hint that it exists. */
    private async visible(tx: WorkspaceClient, context: WorkspaceRunContext, id: string): Promise<MailboxRow> {
        const row = await tx.mailbox.findFirst({ where: { AND: [{ id }, visibleTo(context)] } });
        if (!row) throw new ApiException(404, 'not_found', 'mailbox not found');
        return row;
    }

    /** The mailbox if the caller may change it: its owner or an admin. Seen but not theirs is `403`. */
    private async changeable(tx: WorkspaceClient, context: WorkspaceRunContext, id: string): Promise<MailboxRow> {
        const row = await this.visible(tx, context, id);
        if (!isAdmin(context) && row.ownerMemberId !== context.memberId) {
            throw new ApiException(403, 'forbidden', "only the mailbox's owner or an admin may change it");
        }
        return row;
    }

    private current(): WorkspaceRunContext {
        const context = this.context.get();
        if (!context) throw new Error('mailboxes used outside a workspace context');
        return context;
    }
}

/**
 * What a connect asks Google for: Postmaster's scopes; a pool mailbox's two Gmail scopes; a personal
 * mailbox's two and its calendar's read-only scope (CAL-1) — optional, the mailbox works without it.
 */
function scopesFor(purpose: ConnectPurpose): readonly string[] {
    if (purpose === 'postmaster') return POSTMASTER_SCOPES;
    return purpose === 'personal' ? PERSONAL_MAILBOX_SCOPES : GMAIL_SCOPES;
}

function isAdmin(context: WorkspaceRunContext): boolean {
    return context.capabilities.has('workspace:admin');
}

/**
 * Which mailboxes the caller may see, as a filter: one rule for the list and for a single read.
 * The routes require `mailbox:read`; within that, an admin sees every mailbox and anyone else
 * sees their own and the sending pool (an API key, being no one, sees the pool).
 */
function visibleTo(context: WorkspaceRunContext): Prisma.MailboxWhereInput {
    if (isAdmin(context)) return {};
    const pool: Prisma.MailboxWhereInput = { purpose: 'pool' };
    return context.memberId ? { OR: [{ ownerMemberId: context.memberId }, pool] } : pool;
}

/** A mailbox as the API returns it: never a token. */
export function view(row: MailboxRow): MailboxView {
    const lastError = row.lastError as MailboxErrorRecord | null;
    return {
        id: row.id,
        ownerMemberId: row.ownerMemberId,
        email: row.email,
        label: row.label,
        purpose: row.purpose,
        status: row.status,
        grantedScopes: row.grantedScopes,
        lastError: lastError ? { code: lastError.code, message: lastError.message, at: new Date(lastError.at) } : null,
        connectedAt: row.connectedAt,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    };
}

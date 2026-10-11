import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { EventActor, MailboxStatus } from '@bylinecrm/shared';
import type { Prisma } from '@prisma/client';
import { DomainEvents } from '../events/domain-events.service';
import { ApiException } from '../infra/errors/api-errors';
import { RedisService } from '../infra/redis.service';
import { RlsPrismaService } from '../infra/rls-prisma.service';
import { SecretBox } from '../infra/secret-box';
import { GOOGLE_OAUTH_PORT, GoogleOAuthError, type GoogleOAuthPort } from './google-oauth.port';
import {
    TOKEN_LOCK_KEY_PREFIX,
    TOKEN_LOCK_POLL_MS,
    TOKEN_LOCK_TTL_MS,
    TOKEN_REFRESH_SKEW_S,
} from './mail-accounts.constants';
import { OAuthClientsService } from './oauth-clients.service';
import { assessGrant } from './oauth-flow';

type MailboxRow = Prisma.MailboxGetPayload<object>;

/** Why a mailbox stopped working, as stored in `last_error` and shown to its owner. */
export interface MailboxErrorRecord {
    code: string;
    message: string;
    at: string;
}

/** `409`: the mailbox cannot be used until someone acts — it needs reconnecting or was disconnected. */
export class MailboxUnavailable extends ApiException {
    constructor(readonly mailboxStatus: Exclude<MailboxStatus, 'connected'>) {
        super(
            409,
            'conflict',
            mailboxStatus === 'reconnect_needed'
                ? 'the mailbox needs to be connected again'
                : 'the mailbox is disconnected',
        );
    }
}

/** Deletes the lock only if this caller still holds it (its token matches): never another's. */
const RELEASE_LOCK = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

/**
 * The one place an access token is handed out (P2-1). A token close to expiry is refreshed first;
 * a mailbox is refreshed by one process at a time — the others wait for it and read the result —
 * so two workers never race Google with the same refresh token. Google refusing the grant
 * (`invalid_grant`: revoked, expired, the account changed) or withdrawing a scope moves the
 * mailbox to `reconnect_needed` and announces it; nothing is retried against a dead grant.
 */
@Injectable()
export class MailboxTokens {
    constructor(
        private readonly rls: RlsPrismaService,
        private readonly secrets: SecretBox,
        private readonly redis: RedisService,
        private readonly clients: OAuthClientsService,
        private readonly events: DomainEvents,
        @Inject(GOOGLE_OAUTH_PORT) private readonly google: GoogleOAuthPort,
    ) {}

    /**
     * A usable access token for the mailbox. Takes the workspace explicitly: sync and send workers
     * (P2-2, P2-3) call it outside any request.
     */
    async getAccessToken(workspaceId: string, mailboxId: string): Promise<string> {
        const deadline = Date.now() + TOKEN_LOCK_TTL_MS;
        for (;;) {
            const row = await this.read(workspaceId, mailboxId);
            const fresh = this.freshToken(row);
            if (fresh) return fresh;
            const lockToken = await this.acquire(mailboxId);
            if (lockToken) {
                try {
                    return await this.refreshUnderLock(workspaceId, mailboxId);
                } finally {
                    await this.release(mailboxId, lockToken);
                }
            }
            if (Date.now() >= deadline) throw new Error('timed out waiting for another process to refresh the mailbox');
            await sleep(TOKEN_LOCK_POLL_MS);
        }
    }

    /**
     * Moves a working mailbox to `reconnect_needed` with the reason, and announces it once. A
     * mailbox already in that state (or disconnected) is left as it is: nothing changed, so
     * nothing is announced.
     */
    async markReconnectNeeded(
        workspaceId: string,
        mailboxId: string,
        reason: { code: string; message: string },
        actor: EventActor,
    ): Promise<boolean> {
        return this.rls.withWorkspace(workspaceId, async (tx) => {
            const result = await tx.mailbox.updateMany({
                where: { id: mailboxId, status: 'connected' },
                data: {
                    status: 'reconnect_needed',
                    lastError: errorRecord(reason),
                },
            });
            if (result.count === 0) return false;
            await this.events.record(tx, {
                type: 'mailbox.reconnect_needed',
                object: 'mailbox',
                workspaceId,
                actor,
                occurredAt: new Date().toISOString(),
                recordId: mailboxId,
            });
            return true;
        });
    }

    private async refreshUnderLock(workspaceId: string, mailboxId: string): Promise<string> {
        // Another process may have refreshed between our read and our lock.
        const row = await this.read(workspaceId, mailboxId);
        const fresh = this.freshToken(row);
        if (fresh) return fresh;
        const client = await this.rls.withWorkspace(workspaceId, (tx) => this.clients.storedIn(tx));
        // A client cannot be removed while a mailbox is live, so its absence is a defect, not a state.
        if (!client) throw new Error('a live mailbox has no OAuth client to refresh through');
        if (!row.refreshTokenCiphertext) throw new Error('a live mailbox has no refresh token');

        let grant;
        try {
            grant = await this.google.refresh(client, this.secrets.open(row.refreshTokenCiphertext));
        } catch (error) {
            if (error instanceof GoogleOAuthError && error.error === 'invalid_grant') {
                await this.markReconnectNeeded(
                    workspaceId,
                    mailboxId,
                    {
                        code: 'invalid_grant',
                        message: 'Google no longer accepts this connection; connect the mailbox again',
                    },
                    { kind: 'system', id: null },
                );
                throw new MailboxUnavailable('reconnect_needed');
            }
            throw error;
        }

        // A refresh reports the token's scopes; a narrow scope withdrawn in the Google account
        // means the mailbox can no longer do its job.
        if (grant.scopes.length > 0) {
            const assessment = assessGrant(grant.scopes);
            if (!assessment.ok) {
                await this.markReconnectNeeded(
                    workspaceId,
                    mailboxId,
                    { code: assessment.result, message: assessment.detail },
                    { kind: 'system', id: null },
                );
                throw new MailboxUnavailable('reconnect_needed');
            }
        }

        await this.rls.withWorkspace(workspaceId, (tx) =>
            tx.mailbox.update({
                where: { id: mailboxId },
                data: {
                    accessTokenCiphertext: this.secrets.seal(grant.accessToken),
                    accessExpiresAt: new Date(Date.now() + grant.expiresInS * 1000),
                    // Google may rotate the refresh token; the newest one is the one to keep.
                    ...(grant.refreshToken ? { refreshTokenCiphertext: this.secrets.seal(grant.refreshToken) } : {}),
                    ...(grant.scopes.length > 0 ? { grantedScopes: grant.scopes } : {}),
                },
            }),
        );
        return grant.accessToken;
    }

    private async read(workspaceId: string, mailboxId: string): Promise<MailboxRow> {
        const row = await this.rls.withWorkspace(workspaceId, (tx) =>
            tx.mailbox.findUnique({ where: { id: mailboxId } }),
        );
        if (!row) throw new ApiException(404, 'not_found', 'mailbox not found');
        if (row.status !== 'connected') throw new MailboxUnavailable(row.status);
        return row;
    }

    /** The stored access token if it is valid for longer than the skew; otherwise nothing. */
    private freshToken(row: MailboxRow): string | null {
        if (!row.accessTokenCiphertext || !row.accessExpiresAt) return null;
        if (row.accessExpiresAt.getTime() - Date.now() <= TOKEN_REFRESH_SKEW_S * 1000) return null;
        return this.secrets.open(row.accessTokenCiphertext);
    }

    private async acquire(mailboxId: string): Promise<string | null> {
        await this.redis.ensureReady();
        const token = randomUUID();
        const ok = await this.redis.set(`${TOKEN_LOCK_KEY_PREFIX}${mailboxId}`, token, 'PX', TOKEN_LOCK_TTL_MS, 'NX');
        return ok === 'OK' ? token : null;
    }

    private async release(mailboxId: string, token: string): Promise<void> {
        await this.redis.eval(RELEASE_LOCK, 1, `${TOKEN_LOCK_KEY_PREFIX}${mailboxId}`, token);
    }
}

/** What `last_error` holds: the reason and when, as JSON. */
function errorRecord(reason: { code: string; message: string }): Prisma.InputJsonObject {
    const record: MailboxErrorRecord = { ...reason, at: new Date().toISOString() };
    return { code: record.code, message: record.message, at: record.at };
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

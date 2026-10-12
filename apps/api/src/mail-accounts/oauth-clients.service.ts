import { Inject, Injectable } from '@nestjs/common';
import { GMAIL_SCOPES, type OAuthCheckOutcome } from '@bylinecrm/shared';
import { Prisma } from '@prisma/client';
import { ENV, type Env } from '../config/env';
import { ApiException } from '../infra/errors/api-errors';
import { RlsPrismaService, type WorkspaceClient } from '../infra/rls-prisma.service';
import { SecretBox } from '../infra/secret-box';
import { WorkspaceContext } from '../infra/workspace-context';
import {
    GOOGLE_OAUTH_PORT,
    GoogleOAuthError,
    type GoogleOAuthPort,
    type OAuthClientCredentials,
} from './google-oauth.port';
import {
    CLIENT_SECRET_SHOWN_CHARS,
    GOOGLE_CLIENT_ID_PATTERN,
    MAIL_OAUTH_CALLBACK_PATH,
    OAUTH_CHECK_MESSAGES as M,
} from './mail-accounts.constants';
import type { OAuthClientCheck, OAuthClientStatus, OAuthClientView } from './responses';

type ClientRow = Prisma.GoogleOAuthClientGetPayload<object>;

/** A stored client, decrypted, with the id the mailboxes and connect requests compare against. */
export interface StoredClient extends OAuthClientCredentials {
    rowId: string;
}

/**
 * The workspace's own Google OAuth client (D-237): one per workspace, configured by an admin.
 * The secret is sealed with the secrets key and shown only as its last four characters; this
 * service is the one place it is decrypted, and only to be presented to Google.
 */
@Injectable()
export class OAuthClientsService {
    constructor(
        private readonly rls: RlsPrismaService,
        private readonly context: WorkspaceContext,
        private readonly secrets: SecretBox,
        @Inject(GOOGLE_OAUTH_PORT) private readonly google: GoogleOAuthPort,
        @Inject(ENV) private readonly env: Env,
    ) {}

    /** The exact redirect URI to register at Google: one place builds it. */
    redirectUri(): string {
        return new URL(MAIL_OAUTH_CALLBACK_PATH, this.env.APP_URL).toString();
    }

    /** What the setup screen shows — also when nothing is configured yet (step 1 needs the URI). */
    describe(): Promise<OAuthClientView> {
        return this.rls.withWorkspace(async (tx) => {
            const row = await tx.googleOAuthClient.findFirst();
            return this.view(row, await liveMailboxes(tx));
        });
    }

    /** What a member connecting a mailbox needs to know: set up or not, proven or not — nothing identifying. */
    status(): Promise<OAuthClientStatus> {
        return this.rls.withWorkspace(async (tx) => {
            const row = await tx.googleOAuthClient.findFirst({ select: { verifiedAt: true } });
            return {
                configured: row !== null,
                verified: row?.verifiedAt != null,
                redirectUri: this.redirectUri(),
                scopes: [...GMAIL_SCOPES],
            };
        });
    }

    /**
     * Sets the client. A different client ID while live mailboxes use the current one is refused:
     * their refresh tokens belong to the current client and would stop working. A new secret for
     * the same client ID is allowed (a rotation in Google Cloud). Either change clears the last
     * check and the verification, since the new credentials are unproven.
     */
    put(input: { clientId: string; clientSecret: string }): Promise<OAuthClientView> {
        const { workspaceId, memberId } = this.current();
        if (!memberId)
            throw new ApiException(403, 'forbidden', 'the OAuth client is configured by a member, not by an API key');
        return this.rls.withWorkspace(async (tx) => {
            const existing = await tx.googleOAuthClient.findFirst();
            const live = await liveMailboxes(tx);
            if (existing && existing.clientId !== input.clientId && live > 0) {
                throw new ApiException(
                    409,
                    'conflict',
                    `${live} mailbox${live === 1 ? ' is' : 'es are'} connected through the current client; disconnect ${live === 1 ? 'it' : 'them'} before changing the client ID`,
                );
            }
            const data = {
                clientId: input.clientId,
                clientSecretCiphertext: this.secrets.seal(input.clientSecret),
                clientSecretLast4: input.clientSecret.slice(-CLIENT_SECRET_SHOWN_CHARS),
                configuredById: memberId,
                verifiedAt: null,
                lastCheck: Prisma.DbNull,
            };
            const row = existing
                ? await tx.googleOAuthClient.update({ where: { id: existing.id }, data })
                : await tx.googleOAuthClient.create({ data: { workspaceId, ...data } });
            return this.view(row, live);
        });
    }

    /** Removes the client; refused while any mailbox connected through it is not disconnected. */
    remove(): Promise<void> {
        return this.rls.withWorkspace(async (tx) => {
            const existing = await tx.googleOAuthClient.findFirst();
            if (!existing) throw new ApiException(404, 'not_found', 'no OAuth client is configured');
            const live = await liveMailboxes(tx);
            if (live > 0) {
                throw new ApiException(
                    409,
                    'conflict',
                    `${live} mailbox${live === 1 ? ' is' : 'es are'} connected through this client; disconnect ${live === 1 ? 'it' : 'them'} first`,
                );
            }
            await tx.googleOAuthClient.delete({ where: { id: existing.id } });
        });
    }

    /**
     * Checks what can be checked without a person signing in, and records it: the client ID's
     * shape (here), then whether Google knows the client and accepts its secret (an exchange of a
     * code Google never issued). The redirect URI is reported `unverified` unless Google says it
     * is wrong; the first successful connect proves it.
     */
    async verify(): Promise<OAuthClientView> {
        const stored = await this.rls.withWorkspace((tx) => this.storedIn(tx));
        if (!stored) throw new ApiException(404, 'not_found', 'no OAuth client is configured');
        const check = await this.runCheck(stored);
        return this.rls.withWorkspace(async (tx) => {
            const row = await tx.googleOAuthClient.update({
                where: { id: stored.rowId },
                data: { lastCheck: { ...check, checkedAt: check.checkedAt.toISOString() } },
            });
            return this.view(row, await liveMailboxes(tx));
        });
    }

    /** The decrypted client inside a caller's transaction, or null when none is configured. */
    async storedIn(tx: WorkspaceClient): Promise<StoredClient | null> {
        const row = await tx.googleOAuthClient.findFirst();
        if (!row) return null;
        return { rowId: row.id, clientId: row.clientId, clientSecret: this.secrets.open(row.clientSecretCiphertext) };
    }

    /**
     * Marks the client proven by a completed connect; a later connect leaves the first time. The
     * connect is also what proves the redirect URI, so the stored check records it here — the one
     * writer of the client's check state besides `verify` — and the setup screen stops reading
     * "not yet confirmed" (#82).
     */
    async markVerifiedIn(tx: WorkspaceClient, rowId: string): Promise<void> {
        const row = await tx.googleOAuthClient.findFirst({
            where: { id: rowId, verifiedAt: null },
            select: { lastCheck: true },
        });
        if (!row) return;
        const lastCheck = row.lastCheck
            ? ({
                  ...(row.lastCheck as Prisma.JsonObject),
                  redirectUri: step('pass', M.redirectProvenByConnect),
              } as Prisma.InputJsonValue)
            : undefined;
        await tx.googleOAuthClient.updateMany({
            where: { id: rowId, verifiedAt: null },
            data: { verifiedAt: new Date(), ...(lastCheck ? { lastCheck } : {}) },
        });
    }

    private async runCheck(stored: StoredClient): Promise<OAuthClientCheck> {
        const checkedAt = new Date();
        if (!GOOGLE_CLIENT_ID_PATTERN.test(stored.clientId)) {
            return {
                checkedAt,
                format: step('fail', M.formatFail),
                credentials: step('unverified', M.notCheckedMalformed),
                redirectUri: step('unverified', M.notCheckedMalformed),
            };
        }
        const format = step('pass', M.formatPass);
        let probe;
        try {
            probe = await this.google.probeClient(stored, this.redirectUri());
        } catch (error) {
            if (!(error instanceof GoogleOAuthError)) throw error;
            return {
                checkedAt,
                format,
                credentials: step('unverified', M.googleUnreachable),
                redirectUri: step('unverified', M.googleUnreachable),
            };
        }
        const credentials =
            probe.credentials === 'accepted'
                ? step('pass', M.credentialsPass)
                : probe.credentials === 'refused'
                  ? step('fail', M.credentialsFail)
                  : step('unverified', M.credentialsUnknown);
        const redirectUri =
            probe.redirectUri === 'not_registered'
                ? step('fail', M.redirectFail)
                : probe.redirectUri === 'registered'
                  ? step('pass', M.redirectPass)
                  : step('unverified', M.redirectAwaitsConnect);
        return { checkedAt, format, credentials, redirectUri };
    }

    private view(row: ClientRow | null, live: number): OAuthClientView {
        return {
            configured: row !== null,
            clientId: row?.clientId ?? null,
            clientSecretLast4: row?.clientSecretLast4 ?? null,
            redirectUri: this.redirectUri(),
            scopes: [...GMAIL_SCOPES],
            verifiedAt: row?.verifiedAt ?? null,
            lastCheck: row?.lastCheck ? readCheck(row.lastCheck) : null,
            liveMailboxes: live,
            configuredBy: row?.configuredById ?? null,
            updatedAt: row?.updatedAt ?? null,
        };
    }

    private current(): { workspaceId: string; memberId?: string | undefined } {
        const context = this.context.get();
        if (!context) throw new Error('OAuth client used outside a workspace context');
        return { workspaceId: context.workspaceId, memberId: context.memberId };
    }
}

/** Mailboxes in the workspace that hold a grant from the current client. */
function liveMailboxes(tx: WorkspaceClient): Promise<number> {
    return tx.mailbox.count({ where: { status: { not: 'disconnected' } } });
}

function step(outcome: OAuthCheckOutcome, message: string): { outcome: OAuthCheckOutcome; message: string } {
    return { outcome, message };
}

/** The stored check, with its time turned back into a `Date`. */
function readCheck(value: Prisma.JsonValue): OAuthClientCheck {
    const stored = value as unknown as Omit<OAuthClientCheck, 'checkedAt'> & { checkedAt: string };
    return { ...stored, checkedAt: new Date(stored.checkedAt) };
}

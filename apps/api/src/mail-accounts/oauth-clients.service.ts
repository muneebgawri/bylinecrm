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

    /** Marks the client proven by a completed connect; a later connect leaves the first time. */
    async markVerifiedIn(tx: WorkspaceClient, rowId: string): Promise<void> {
        await tx.googleOAuthClient.updateMany({
            where: { id: rowId, verifiedAt: null },
            data: { verifiedAt: new Date() },
        });
    }

    private async runCheck(stored: StoredClient): Promise<OAuthClientCheck> {
        const checkedAt = new Date();
        if (!GOOGLE_CLIENT_ID_PATTERN.test(stored.clientId)) {
            return {
                checkedAt,
                format: step('fail', 'the client ID is not a Google web client ID (…apps.googleusercontent.com)'),
                credentials: step('unverified', 'not checked: the client ID is malformed'),
                redirectUri: step('unverified', 'not checked: the client ID is malformed'),
            };
        }
        const format = step('pass', 'the client ID has the shape of a Google web client ID');
        let probe;
        try {
            probe = await this.google.probeClient(stored, this.redirectUri());
        } catch (error) {
            if (!(error instanceof GoogleOAuthError)) throw error;
            return {
                checkedAt,
                format,
                credentials: step('unverified', 'Google could not be reached; try again'),
                redirectUri: step('unverified', 'Google could not be reached; try again'),
            };
        }
        const credentials =
            probe.credentials === 'accepted'
                ? step('pass', 'Google knows this client ID and accepts the secret')
                : probe.credentials === 'refused'
                  ? step('fail', 'Google does not know this client ID, or refuses this secret')
                  : step('unverified', 'Google did not say whether it accepts these credentials');
        const redirectUri =
            probe.redirectUri === 'not_registered'
                ? step('fail', 'Google refused the redirect URI; register it exactly as shown')
                : probe.redirectUri === 'registered'
                  ? step('pass', 'the redirect URI is registered')
                  : step(
                        'unverified',
                        'confirmed when the first mailbox connects; Google checks it only when a person signs in',
                    );
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

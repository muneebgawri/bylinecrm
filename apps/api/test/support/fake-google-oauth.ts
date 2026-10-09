import { createHash, randomBytes } from 'node:crypto';
import { probeFromError } from '../../src/mail-accounts/google-oauth.http';
import {
    GoogleOAuthError,
    type ClientProbe,
    type GoogleOAuthPort,
    type OAuthClientCredentials,
    type TokenGrant,
} from '../../src/mail-accounts/google-oauth.port';

/** A client registered in the fake's "Google Cloud". */
interface FakeClient {
    secret: string;
    redirectUris: string[];
}

/** What a person consented to on the fake's consent screen. */
interface Consent {
    email: string;
    scopes: string[];
    /** Whether the grant includes a refresh token; Google's does with access_type=offline. */
    withRefreshToken?: boolean;
}

interface IssuedCode extends Consent {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
}

interface Grant {
    clientId: string;
    email: string;
    scopes: string[];
    revoked: boolean;
}

/**
 * An in-memory Google for the tests: no network, ever. It enforces what Google enforces — the
 * client's credentials, the redirect URI, the PKCE verifier, a code used once, a revoked grant —
 * so a test passes only if the API does the flow right. Every token it hands out is remembered,
 * so a test can assert that none of them ever appears in a response body or a log line.
 */
export class FakeGoogleOAuth implements GoogleOAuthPort {
    private readonly clients = new Map<string, FakeClient>();
    private readonly codes = new Map<string, IssuedCode>();
    private readonly grants = new Map<string, Grant>();
    private readonly accessTokens = new Map<string, { grantKey: string; scopes: string[] }>();
    private readonly refreshTokens = new Map<string, string>();

    /** Every token and secret value issued, for leak assertions. */
    readonly issued: string[] = [];
    refreshCalls = 0;
    revokeCalls = 0;
    /** Makes each refresh take this long, so concurrent callers overlap. */
    refreshDelayMs = 0;
    /** When set, the next code exchanges fail with this Google error. */
    failExchangeWith: string | null = null;

    registerClient(clientId: string, secret: string, redirectUris: string[]): void {
        this.clients.set(clientId, { secret, redirectUris });
        this.issued.push(secret);
    }

    /**
     * The consent screen: reads the authorization URL the API built (as a browser would follow it)
     * and returns the code Google would append to the redirect. Throws if the URL is not one
     * Google would accept.
     */
    consent(authorizeUrl: string, consent: Consent): { code: string; state: string; redirectUri: string } {
        const url = new URL(authorizeUrl);
        const clientId = url.searchParams.get('client_id') ?? '';
        const redirectUri = url.searchParams.get('redirect_uri') ?? '';
        const client = this.clients.get(clientId);
        if (!client) throw new Error(`fake Google: unknown client ${clientId}`);
        if (!client.redirectUris.includes(redirectUri)) throw new Error('fake Google: redirect_uri_mismatch');
        if (url.searchParams.get('code_challenge_method') !== 'S256')
            throw new Error('fake Google: PKCE S256 required');
        const code = token('code');
        this.codes.set(code, {
            ...consent,
            clientId,
            redirectUri,
            codeChallenge: url.searchParams.get('code_challenge') ?? '',
        });
        return { code, state: url.searchParams.get('state') ?? '', redirectUri };
    }

    /** The person removes the app's access in their Google account. */
    revokeGrantFor(email: string): void {
        for (const grant of this.grants.values()) if (grant.email === email) grant.revoked = true;
    }

    /** The person keeps the app but Google now reports fewer scopes on its tokens. */
    narrowGrantFor(email: string, scopes: string[]): void {
        for (const grant of this.grants.values()) if (grant.email === email) grant.scopes = scopes;
        for (const access of this.accessTokens.values()) {
            const grant = this.grants.get(access.grantKey);
            if (grant?.email === email) access.scopes = scopes;
        }
    }

    // ── The port ─────────────────────────────────────────────────────────────────────────────

    exchangeCode(
        client: OAuthClientCredentials,
        input: { code: string; codeVerifier: string; redirectUri: string },
    ): Promise<TokenGrant> {
        if (this.failExchangeWith) {
            const error = this.failExchangeWith;
            this.failExchangeWith = null;
            return Promise.reject(new GoogleOAuthError(error, 400, 'token request refused (400)'));
        }
        this.authenticate(client);
        const issued = this.codes.get(input.code);
        this.codes.delete(input.code);
        if (!issued) return reject('invalid_grant');
        if (issued.clientId !== client.clientId || issued.redirectUri !== input.redirectUri)
            return reject('invalid_grant');
        if (createHash('sha256').update(input.codeVerifier).digest('base64url') !== issued.codeChallenge) {
            return reject('invalid_grant');
        }
        const grantKey = `${client.clientId}:${issued.email}`;
        this.grants.set(grantKey, {
            clientId: client.clientId,
            email: issued.email,
            scopes: issued.scopes,
            revoked: false,
        });
        const refreshToken = issued.withRefreshToken === false ? null : token('refresh');
        if (refreshToken) this.refreshTokens.set(refreshToken, grantKey);
        return Promise.resolve(this.accessFor(grantKey, issued.scopes, refreshToken));
    }

    async refresh(client: OAuthClientCredentials, refreshToken: string): Promise<TokenGrant> {
        this.refreshCalls++;
        if (this.refreshDelayMs > 0) await new Promise((r) => setTimeout(r, this.refreshDelayMs));
        this.authenticate(client);
        const grantKey = this.refreshTokens.get(refreshToken);
        const grant = grantKey ? this.grants.get(grantKey) : undefined;
        if (!grantKey || !grant || grant.revoked)
            throw new GoogleOAuthError('invalid_grant', 400, 'token request refused (400)');
        return this.accessFor(grantKey, grant.scopes, null);
    }

    mailboxAddress(accessToken: string): Promise<string> {
        const access = this.accessTokens.get(accessToken);
        const grant = access ? this.grants.get(access.grantKey) : undefined;
        if (!grant || grant.revoked)
            return Promise.reject(new GoogleOAuthError('invalid_token', 401, 'Gmail profile read failed (401)'));
        return Promise.resolve(grant.email);
    }

    grantedScopes(accessToken: string): Promise<string[]> {
        const access = this.accessTokens.get(accessToken);
        if (!access)
            return Promise.reject(new GoogleOAuthError('invalid_token', 400, 'token information read failed (400)'));
        return Promise.resolve([...access.scopes]);
    }

    revoke(token: string): Promise<void> {
        this.revokeCalls++;
        const grantKey = this.refreshTokens.get(token) ?? this.accessTokens.get(token)?.grantKey;
        const grant = grantKey ? this.grants.get(grantKey) : undefined;
        if (grant) grant.revoked = true;
        return Promise.resolve();
    }

    probeClient(client: OAuthClientCredentials, redirectUri: string): Promise<ClientProbe> {
        const known = this.clients.get(client.clientId);
        if (!known || known.secret !== client.clientSecret) return Promise.resolve(probeFromError('invalid_client'));
        if (!known.redirectUris.includes(redirectUri)) return Promise.resolve(probeFromError('redirect_uri_mismatch'));
        return Promise.resolve(probeFromError('invalid_grant'));
    }

    // ── Internals ────────────────────────────────────────────────────────────────────────────

    private authenticate(client: OAuthClientCredentials): void {
        const known = this.clients.get(client.clientId);
        if (!known || known.secret !== client.clientSecret) {
            throw new GoogleOAuthError('invalid_client', 401, 'token request refused (401)');
        }
    }

    private accessFor(grantKey: string, scopes: string[], refreshToken: string | null): TokenGrant {
        const accessToken = token('access');
        this.accessTokens.set(accessToken, { grantKey, scopes: [...scopes] });
        this.issued.push(accessToken);
        if (refreshToken) this.issued.push(refreshToken);
        return { accessToken, refreshToken, expiresInS: 3600, scopes: [...scopes] };
    }
}

function token(kind: string): string {
    return `fake-${kind}-${randomBytes(12).toString('base64url')}`;
}

function reject(error: string): Promise<never> {
    return Promise.reject(new GoogleOAuthError(error, 400, 'token request refused (400)'));
}

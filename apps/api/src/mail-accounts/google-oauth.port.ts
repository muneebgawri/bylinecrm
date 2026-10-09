/**
 * Everything the API asks Google about a workspace's OAuth client and its mailboxes, behind one
 * interface (P2-1). The HTTP adapter (`google-oauth.http.ts`) is the only code that talks to
 * Google; tests bind an in-memory fake (`test/support/fake-google-oauth.ts`), so no test and no
 * CI run ever calls Google.
 */

/** A workspace's own OAuth client, decrypted, for the length of one call. */
export interface OAuthClientCredentials {
    clientId: string;
    clientSecret: string;
}

/** What a code exchange or a refresh returned. */
export interface TokenGrant {
    accessToken: string;
    /** Present on a first grant with `access_type=offline`; usually absent on a refresh. */
    refreshToken: string | null;
    /** Seconds the access token is valid for, from now. */
    expiresInS: number;
    /** The scopes this token carries — what was actually granted, not what was asked for. */
    scopes: string[];
}

/** How a check of the client, made without a person signing in, came out (see `probeClient`). */
export interface ClientProbe {
    credentials: 'accepted' | 'refused' | 'unknown';
    redirectUri: 'registered' | 'not_registered' | 'unknown';
    /** Google's error name, when it gave one; never a token or a secret. */
    googleError: string | null;
}

/**
 * Google answered with an OAuth error (`invalid_grant`, `invalid_client`, …) or failed to answer.
 * `error` is Google's machine name, or `network` / `unexpected_response` for the API's own
 * failures. The message never contains a token or a secret.
 */
export class GoogleOAuthError extends Error {
    constructor(
        readonly error: string,
        readonly status: number | null,
        message: string,
    ) {
        super(message);
        this.name = 'GoogleOAuthError';
    }
}

export interface GoogleOAuthPort {
    /** Exchanges the authorization code from the callback (with its PKCE verifier) for tokens. */
    exchangeCode(
        client: OAuthClientCredentials,
        input: { code: string; codeVerifier: string; redirectUri: string },
    ): Promise<TokenGrant>;

    /** A new access token from a refresh token. `invalid_grant` means the grant is gone. */
    refresh(client: OAuthClientCredentials, refreshToken: string): Promise<TokenGrant>;

    /** The mailbox's address, from Gmail's profile (needs `gmail.readonly`). */
    mailboxAddress(accessToken: string): Promise<string>;

    /** The scopes an access token carries now, from Google's token information. */
    grantedScopes(accessToken: string): Promise<string[]>;

    /**
     * Revokes a token at Google. Google revokes the whole grant — every token that Google account
     * gave this client — so it is used only when the mailbox itself is being let go.
     */
    revoke(token: string): Promise<void>;

    /**
     * Checks a client without a person present: an exchange of a code Google never issued always
     * fails, and the error says how far Google got. `invalid_client` — Google does not know the
     * client ID or refuses the secret. `invalid_grant` — Google accepted the client ID and secret
     * and refused only the code. `redirect_uri_mismatch` — Google accepted the client and refused
     * the redirect URI. Whether Google checks the redirect URI at this step at all is not something
     * the API can rely on, so a passing exchange leaves the redirect URI `unknown`; the first
     * successful connect is what proves it (P2-1 design note).
     */
    probeClient(client: OAuthClientCredentials, redirectUri: string): Promise<ClientProbe>;
}

/** Injection token for the port. */
export const GOOGLE_OAUTH_PORT = Symbol('GOOGLE_OAUTH_PORT');

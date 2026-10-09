import { afterEach, describe, expect, it, vi } from 'vitest';
import { GoogleOAuthHttp, probeFromError, splitScopes } from './google-oauth.http';
import { GoogleOAuthError } from './google-oauth.port';

const client = { clientId: '123-abc.apps.googleusercontent.com', clientSecret: 'shh-secret' };

function respond(status: number, body: unknown): void {
    vi.stubGlobal(
        'fetch',
        vi.fn(() =>
            Promise.resolve(
                new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
            ),
        ),
    );
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('the HTTP adapter', () => {
    const http = new GoogleOAuthHttp();

    it("reads a token response, splitting Google's space-separated scopes", async () => {
        respond(200, { access_token: 'at', expires_in: 3599, refresh_token: 'rt', scope: 'a b' });
        await expect(
            http.exchangeCode(client, { code: 'c', codeVerifier: 'v', redirectUri: 'https://x/cb' }),
        ).resolves.toEqual({ accessToken: 'at', refreshToken: 'rt', expiresInS: 3599, scopes: ['a', 'b'] });
    });

    it("turns Google's OAuth error into a GoogleOAuthError carrying only the error name", async () => {
        respond(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
        const error = await http.refresh(client, 'rt').catch((e: unknown) => e);
        expect(error).toBeInstanceOf(GoogleOAuthError);
        expect(error).toMatchObject({ error: 'invalid_grant', status: 400 });
        expect((error as Error).message).not.toContain('expired or revoked');
    });

    it('a network failure never repeats the URL, which can carry a token', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(() =>
                Promise.reject(
                    new Error('connect ECONNREFUSED https://oauth2.googleapis.com/tokeninfo?access_token=secret-at'),
                ),
            ),
        );
        const error = await http.grantedScopes('secret-at').catch((e: unknown) => e);
        expect(error).toMatchObject({ error: 'network' });
        expect((error as Error).message).not.toContain('secret-at');
    });

    it('a token Google no longer knows counts as revoked', async () => {
        respond(400, { error: 'invalid_token' });
        await expect(http.revoke('rt')).resolves.toBeUndefined();
    });

    it("sends the client's credentials and the PKCE verifier in the form body, never the URL", async () => {
        const fetchMock = vi.fn((_url: string | URL, _init?: RequestInit) =>
            Promise.resolve(
                new Response(JSON.stringify({ access_token: 'at', expires_in: 10, scope: '' }), { status: 200 }),
            ),
        );
        vi.stubGlobal('fetch', fetchMock);
        await http.exchangeCode(client, { code: 'c', codeVerifier: 'v', redirectUri: 'https://x/cb' });
        const [url, init] = fetchMock.mock.calls[0]!;
        expect(String(url)).not.toContain('shh-secret');
        const form = new URLSearchParams(String(init?.body));
        expect(Object.fromEntries(form)).toMatchObject({
            grant_type: 'authorization_code',
            code_verifier: 'v',
            client_secret: 'shh-secret',
        });
    });
});

describe('what a probe error says about a client', () => {
    it.each([
        ['invalid_client', 'refused', 'unknown'],
        ['unauthorized_client', 'refused', 'unknown'],
        ['redirect_uri_mismatch', 'accepted', 'not_registered'],
        ['invalid_grant', 'accepted', 'unknown'],
        ['something_else', 'unknown', 'unknown'],
    ])('%s → credentials %s, redirect URI %s', (error, credentials, redirectUri) => {
        expect(probeFromError(error)).toEqual({ credentials, redirectUri, googleError: error });
    });

    it('an empty scope string is no scopes', () => {
        expect(splitScopes('')).toEqual([]);
        expect(splitScopes(' a  b ')).toEqual(['a', 'b']);
    });
});

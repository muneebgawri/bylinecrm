import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import {
    GoogleOAuthError,
    type ClientProbe,
    type GoogleOAuthPort,
    type OAuthClientCredentials,
    type TokenGrant,
} from './google-oauth.port';
import { GOOGLE_ENDPOINTS, GOOGLE_HTTP_TIMEOUT_MS, PROBE_AUTHORIZATION_CODE } from './mail-accounts.constants';

/** Google's token endpoint on success (RFC 6749 §5.1, with Google's space-separated `scope`). */
const tokenResponse = z.object({
    access_token: z.string().min(1),
    expires_in: z.number().int().positive(),
    refresh_token: z.string().min(1).optional(),
    scope: z.string().default(''),
});

/** An OAuth error body (RFC 6749 §5.2). */
const errorResponse = z.object({ error: z.string().min(1), error_description: z.string().optional() });

const profileResponse = z.object({ emailAddress: z.string().min(1) });
const userinfoResponse = z.object({ email: z.string().min(1) });
const tokenInfoResponse = z.object({ scope: z.string().default('') });

/**
 * The port, over HTTPS to Google. Every call has a timeout; every failure becomes a
 * `GoogleOAuthError` carrying Google's error name and nothing else Google sent — an error
 * description is free text and stays out of messages that may be logged.
 */
@Injectable()
export class GoogleOAuthHttp implements GoogleOAuthPort {
    async exchangeCode(
        client: OAuthClientCredentials,
        input: { code: string; codeVerifier: string; redirectUri: string },
    ): Promise<TokenGrant> {
        return grant(
            await this.tokenRequest({
                grant_type: 'authorization_code',
                code: input.code,
                code_verifier: input.codeVerifier,
                redirect_uri: input.redirectUri,
                client_id: client.clientId,
                client_secret: client.clientSecret,
            }),
        );
    }

    async refresh(client: OAuthClientCredentials, refreshToken: string): Promise<TokenGrant> {
        return grant(
            await this.tokenRequest({
                grant_type: 'refresh_token',
                refresh_token: refreshToken,
                client_id: client.clientId,
                client_secret: client.clientSecret,
            }),
        );
    }

    async mailboxAddress(accessToken: string): Promise<string> {
        const res = await send(GOOGLE_ENDPOINTS.gmailProfile, { headers: { authorization: `Bearer ${accessToken}` } });
        if (!res.ok)
            throw new GoogleOAuthError(await errorName(res), res.status, `Gmail profile read failed (${res.status})`);
        return parse(profileResponse, await json(res)).emailAddress;
    }

    async accountEmail(accessToken: string): Promise<string> {
        const res = await send(GOOGLE_ENDPOINTS.userinfo, { headers: { authorization: `Bearer ${accessToken}` } });
        if (!res.ok)
            throw new GoogleOAuthError(
                await errorName(res),
                res.status,
                `account information read failed (${res.status})`,
            );
        return parse(userinfoResponse, await json(res)).email;
    }

    async grantedScopes(accessToken: string): Promise<string[]> {
        // Google's token-information endpoint takes the token as a query parameter; the request
        // goes to Google over TLS and the URL is never logged here.
        const url = new URL(GOOGLE_ENDPOINTS.tokenInfo);
        url.searchParams.set('access_token', accessToken);
        const res = await send(url, {});
        if (!res.ok)
            throw new GoogleOAuthError(
                await errorName(res),
                res.status,
                `token information read failed (${res.status})`,
            );
        return splitScopes(parse(tokenInfoResponse, await json(res)).scope);
    }

    async revoke(token: string): Promise<void> {
        const res = await send(GOOGLE_ENDPOINTS.revoke, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ token }).toString(),
        });
        // A token Google no longer knows is already revoked: the outcome the caller wanted.
        if (!res.ok && (await errorName(res)) !== 'invalid_token') {
            throw new GoogleOAuthError('revoke_failed', res.status, `revoke failed (${res.status})`);
        }
    }

    async probeClient(client: OAuthClientCredentials, redirectUri: string): Promise<ClientProbe> {
        try {
            await this.tokenRequest({
                grant_type: 'authorization_code',
                code: PROBE_AUTHORIZATION_CODE,
                redirect_uri: redirectUri,
                client_id: client.clientId,
                client_secret: client.clientSecret,
            });
        } catch (error) {
            if (!(error instanceof GoogleOAuthError)) throw error;
            return probeFromError(error.error);
        }
        // A code Google never issued was accepted: nothing about that can be trusted.
        return { credentials: 'unknown', redirectUri: 'unknown', googleError: null };
    }

    private async tokenRequest(form: Record<string, string>): Promise<unknown> {
        const res = await send(GOOGLE_ENDPOINTS.token, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams(form).toString(),
        });
        if (!res.ok)
            throw new GoogleOAuthError(await errorName(res), res.status, `token request refused (${res.status})`);
        return json(res);
    }
}

/** What each probe error says about the client. One table, read by the adapter and the fake alike. */
export function probeFromError(error: string): ClientProbe {
    switch (error) {
        case 'invalid_client':
        case 'unauthorized_client':
            return { credentials: 'refused', redirectUri: 'unknown', googleError: error };
        case 'redirect_uri_mismatch':
            return { credentials: 'accepted', redirectUri: 'not_registered', googleError: error };
        case 'invalid_grant':
            return { credentials: 'accepted', redirectUri: 'unknown', googleError: error };
        default:
            return { credentials: 'unknown', redirectUri: 'unknown', googleError: error };
    }
}

/** Google's `scope` is space-separated; an empty string is no scopes. */
export function splitScopes(scope: string): string[] {
    return scope.split(' ').filter((s) => s.length > 0);
}

function grant(body: unknown): TokenGrant {
    const parsed = parse(tokenResponse, body);
    return {
        accessToken: parsed.access_token,
        refreshToken: parsed.refresh_token ?? null,
        expiresInS: parsed.expires_in,
        scopes: splitScopes(parsed.scope),
    };
}

async function send(url: string | URL, init: RequestInit): Promise<Response> {
    try {
        return await fetch(url, { ...init, signal: AbortSignal.timeout(GOOGLE_HTTP_TIMEOUT_MS) });
    } catch {
        // The underlying error can carry the URL, and the token-information URL carries a token.
        throw new GoogleOAuthError('network', null, 'Google could not be reached');
    }
}

async function json(res: Response): Promise<unknown> {
    try {
        return await res.json();
    } catch {
        throw new GoogleOAuthError('unexpected_response', res.status, 'Google answered with something other than JSON');
    }
}

async function errorName(res: Response): Promise<string> {
    try {
        const body = errorResponse.safeParse(await res.json());
        return body.success ? body.data.error : 'unexpected_response';
    } catch {
        return 'unexpected_response';
    }
}

function parse<S extends z.ZodType>(schema: S, body: unknown): z.output<S> {
    const result = schema.safeParse(body);
    if (!result.success)
        throw new GoogleOAuthError('unexpected_response', null, 'Google answered in an unexpected shape');
    return result.data;
}

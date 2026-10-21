import { createVerify, generateKeyPairSync } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GoogleDelegationHttp, parseServiceAccountKey, ServiceAccountKeyRejected } from './google-delegation.http';
import { GoogleOAuthError } from './google-oauth.port';
import { GOOGLE_ENDPOINTS, JWT_BEARER_GRANT_TYPE } from './mail-accounts.constants';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const keyFile = {
    type: 'service_account',
    project_id: 'p',
    private_key_id: 'abcdef123456',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    client_email: 'Sync@p.iam.gserviceaccount.com',
    client_id: '1234567890123',
    token_uri: 'https://evil.example/token',
};
const AUTHORISED = new Set(['https://www.googleapis.com/auth/gmail.readonly']);
const WORKSPACE_USERS = new Set(['matt@pinionpartners.co']);

/**
 * A fake token endpoint for the JWT grant: it verifies the assertion's RS256 signature with the service
 * account's public key and its claims, as Google does, and answers like Google.
 */
let server: Server;
let url: string;
const seen: { header: Record<string, unknown>; claims: Record<string, unknown> }[] = [];

beforeAll(async () => {
    server = createServer((req, res) => {
        let body = '';
        req.on('data', (c: Buffer) => (body += c.toString()));
        req.on('end', () => {
            const reply = (status: number, json: unknown) => {
                res.writeHead(status, { 'content-type': 'application/json' });
                res.end(JSON.stringify(json));
            };
            const form = new URLSearchParams(body);
            if (form.get('grant_type') !== JWT_BEARER_GRANT_TYPE)
                return reply(400, { error: 'unsupported_grant_type' });
            const [h, c, s] = (form.get('assertion') ?? '').split('.');
            const ok = createVerify('RSA-SHA256')
                .update(`${h}.${c}`)
                .verify(publicKey, Buffer.from(s ?? '', 'base64url'));
            if (!ok) return reply(400, { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' });
            const header = JSON.parse(Buffer.from(h!, 'base64url').toString()) as Record<string, unknown>;
            const claims = JSON.parse(Buffer.from(c!, 'base64url').toString()) as Record<string, unknown>;
            seen.push({ header, claims });
            const scopes = String(claims['scope']).split(' ');
            if (scopes.some((x) => !AUTHORISED.has(x))) {
                return reply(401, { error: 'unauthorized_client', error_description: 'Client is unauthorized' });
            }
            if (!WORKSPACE_USERS.has(String(claims['sub']))) return reply(400, { error: 'invalid_grant' });
            reply(200, { access_token: `at-${String(claims['sub'])}`, expires_in: 3599, token_type: 'Bearer' });
        });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/token`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('the delegation HTTP adapter (#225)', () => {
    const now = 1_700_000_000_000;
    const key = parseServiceAccountKey(JSON.stringify(keyFile));

    it('mints a token with a signed assertion whose subject is the member', async () => {
        const http = new GoogleDelegationHttp(url, () => now);
        await expect(http.mint(key, 'matt@pinionpartners.co', [...AUTHORISED])).resolves.toEqual({
            accessToken: 'at-matt@pinionpartners.co',
            expiresInS: 3599,
        });
        const last = seen.at(-1)!;
        expect(last.header).toEqual({ alg: 'RS256', typ: 'JWT', kid: 'abcdef123456' });
        expect(last.claims).toEqual({
            iss: 'sync@p.iam.gserviceaccount.com',
            sub: 'matt@pinionpartners.co',
            scope: 'https://www.googleapis.com/auth/gmail.readonly',
            // Google's audience, never the key file's `token_uri`.
            aud: GOOGLE_ENDPOINTS.token,
            iat: now / 1000,
            exp: now / 1000 + 3600,
        });
    });

    it('a scope the Admin console does not authorise is unauthorized_client', async () => {
        const http = new GoogleDelegationHttp(url);
        const error = await http
            .mint(key, 'matt@pinionpartners.co', ['https://www.googleapis.com/auth/gmail.send'])
            .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(GoogleOAuthError);
        expect(error).toMatchObject({ error: 'unauthorized_client', status: 401 });
    });

    it('a subject outside the Workspace is invalid_grant', async () => {
        const http = new GoogleDelegationHttp(url);
        await expect(http.mint(key, 'someone@else.example', [...AUTHORISED])).rejects.toMatchObject({
            error: 'invalid_grant',
        });
    });
});

describe('reading a service account key', () => {
    it('keeps what the grant needs and lower-cases the account', () => {
        expect(parseServiceAccountKey(JSON.stringify(keyFile))).toMatchObject({
            clientEmail: 'sync@p.iam.gserviceaccount.com',
            clientId: '1234567890123',
            privateKeyId: 'abcdef123456',
        });
    });

    it.each([
        ['not JSON', 'nope'],
        ['another kind of credential', JSON.stringify({ ...keyFile, type: 'authorized_user' })],
        ['a broken private key', JSON.stringify({ ...keyFile, private_key: '-----BEGIN PRIVATE KEY-----\nxx' })],
    ])('refuses %s without repeating it', (_, text) => {
        const error = (() => {
            try {
                parseServiceAccountKey(text);
            } catch (e) {
                return e as Error;
            }
            return null;
        })();
        expect(error).toBeInstanceOf(ServiceAccountKeyRejected);
        expect(error!.message).not.toContain('PRIVATE KEY');
    });
});

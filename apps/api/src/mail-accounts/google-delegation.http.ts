import { createPrivateKey, createSign } from 'node:crypto';
import { z } from 'zod';
import type { DelegatedToken, GoogleDelegationPort, ServiceAccountKey } from './google-delegation.port';
import { GoogleOAuthError } from './google-oauth.port';
import { errorName, json, parse, send } from './google-oauth.http';
import {
    DELEGATION_ASSERTION_TTL_S,
    GOOGLE_ENDPOINTS,
    JWT_BEARER_GRANT_TYPE,
    SERVICE_ACCOUNT_KEY_MAX,
} from './mail-accounts.constants';

const tokenResponse = z.object({
    access_token: z.string().min(1),
    expires_in: z.number().int().positive(),
});

/**
 * The port over HTTPS (#225): signs an RS256 assertion with the service account's private key and
 * exchanges it at Google's token endpoint. The token URL is Google's, whatever the uploaded key's
 * `token_uri` says — an uploaded file never chooses where the API sends a signed assertion. Tests pass
 * a fake endpoint's URL; the assertion's audience stays Google's.
 */
export class GoogleDelegationHttp implements GoogleDelegationPort {
    constructor(
        private readonly tokenUrl: string = GOOGLE_ENDPOINTS.token,
        private readonly now: () => number = Date.now,
    ) {}

    async mint(key: ServiceAccountKey, subject: string, scopes: readonly string[]): Promise<DelegatedToken> {
        const res = await send(this.tokenUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: JWT_BEARER_GRANT_TYPE,
                assertion: assertion(key, subject, scopes, this.now()),
            }).toString(),
        });
        if (!res.ok)
            throw new GoogleOAuthError(await errorName(res), res.status, `delegated token refused (${res.status})`);
        const body = parse(tokenResponse, await json(res));
        return { accessToken: body.access_token, expiresInS: body.expires_in };
    }
}

/** The signed JWT (RFC 7523 §3): the service account as issuer, the member as subject, the scopes asked for. */
export function assertion(key: ServiceAccountKey, subject: string, scopes: readonly string[], nowMs: number): string {
    const iat = Math.floor(nowMs / 1000);
    const header = encode({ alg: 'RS256', typ: 'JWT', kid: key.privateKeyId });
    const claims = encode({
        iss: key.clientEmail,
        sub: subject,
        scope: scopes.join(' '),
        aud: GOOGLE_ENDPOINTS.token,
        iat,
        exp: iat + DELEGATION_ASSERTION_TTL_S,
    });
    const signature = createSign('RSA-SHA256').update(`${header}.${claims}`).sign(key.privateKey).toString('base64url');
    return `${header}.${claims}.${signature}`;
}

function encode(value: object): string {
    return Buffer.from(JSON.stringify(value)).toString('base64url');
}

/** A service account's JSON key as Google Cloud downloads it; other fields are ignored. */
const keyFile = z.object({
    type: z.literal('service_account'),
    client_email: z.email(),
    client_id: z.string().regex(/^\d{5,40}$/),
    private_key: z.string().min(1),
    private_key_id: z.string().min(4),
});

/** Why an uploaded key was refused; the message is safe to show and never repeats the key. */
export class ServiceAccountKeyRejected extends Error {}

/**
 * Reads an uploaded JSON key: a service account's, with an RSA private key that loads. Throws
 * `ServiceAccountKeyRejected` otherwise.
 */
export function parseServiceAccountKey(text: string): ServiceAccountKey {
    if (text.length > SERVICE_ACCOUNT_KEY_MAX) throw new ServiceAccountKeyRejected('the file is too large to be a key');
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch {
        throw new ServiceAccountKeyRejected('the key is not JSON; upload the .json file Google Cloud downloaded');
    }
    const parsed = keyFile.safeParse(raw);
    if (!parsed.success) {
        throw new ServiceAccountKeyRejected(
            'not a service account key: it needs type "service_account", client_email, client_id, private_key and private_key_id',
        );
    }
    try {
        const loaded = createPrivateKey(parsed.data.private_key);
        if (loaded.asymmetricKeyType !== 'rsa') throw new Error('not RSA');
    } catch {
        throw new ServiceAccountKeyRejected("the key's private_key is not an RSA private key");
    }
    return {
        clientEmail: parsed.data.client_email.toLowerCase(),
        clientId: parsed.data.client_id,
        privateKey: parsed.data.private_key,
        privateKeyId: parsed.data.private_key_id,
    };
}

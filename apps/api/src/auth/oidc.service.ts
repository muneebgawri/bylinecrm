import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import * as client from 'openid-client';
import { ENV, type Env, type OidcIssuerConfig } from '../config/env';
import { RedisService } from '../infra/redis.service';
import { OIDC_STATE_TTL_S } from './auth.constants';
import type { VerifiedIdentity } from './auth.service';

/** Google is an OIDC issuer like any other; it is just configured by two variables, not JSON. */
const GOOGLE_ISSUER = 'https://accounts.google.com';
export const GOOGLE_KEY = 'google';

/** Identity only: who the person is and their verified address. No Gmail scope lives here. */
const SCOPE = 'openid email profile';

/** What an authorization request leaves behind until the provider calls back. */
interface PendingAuth {
    issuer: string;
    nonce: string;
    codeVerifier: string;
}

/**
 * The OIDC relying party. Issuers come from configuration; discovery runs once per issuer and
 * is cached. Every authorization request carries state, nonce and PKCE; the callback is accepted
 * only against the pending request its state names, and the identity it yields is used only if
 * the provider marks the email verified.
 */
@Injectable()
export class OidcService {
    private readonly issuers = new Map<string, OidcIssuerConfig>();
    private readonly configurations = new Map<string, Promise<client.Configuration>>();

    constructor(
        @Inject(ENV) private readonly env: Env,
        private readonly redis: RedisService,
    ) {
        if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
            this.issuers.set(GOOGLE_KEY, {
                key: GOOGLE_KEY,
                issuerUrl: GOOGLE_ISSUER,
                clientId: env.GOOGLE_CLIENT_ID,
                clientSecret: env.GOOGLE_CLIENT_SECRET,
            });
        }
        for (const issuer of env.OIDC_ISSUERS) this.issuers.set(issuer.key, issuer);
    }

    /** The issuer keys an operator configured; the web app lists them as sign-in buttons. */
    available(): string[] {
        return [...this.issuers.keys()];
    }

    /** The exact redirect URI to register at the provider for `key`. */
    redirectUri(key: string): string {
        return new URL(`/api/auth/oidc/${key}/callback`, this.env.APP_URL).toString();
    }

    /** Starts sign-in: returns the provider URL to send the browser to. */
    async start(key: string): Promise<URL> {
        const config = await this.configuration(key);
        const codeVerifier = client.randomPKCECodeVerifier();
        const state = client.randomState();
        const nonce = client.randomNonce();
        await this.remember(state, { issuer: key, nonce, codeVerifier });
        return client.buildAuthorizationUrl(config, {
            redirect_uri: this.redirectUri(key),
            scope: SCOPE,
            state,
            nonce,
            code_challenge: await client.calculatePKCECodeChallenge(codeVerifier),
            code_challenge_method: 'S256',
        });
    }

    /** Finishes sign-in from the callback URL; the identity is verified or an error is thrown. */
    async finish(key: string, callbackUrl: URL): Promise<VerifiedIdentity> {
        const state = callbackUrl.searchParams.get('state');
        if (!state) throw new BadRequestException('missing state');
        const pending = await this.forget(state);
        if (!pending || pending.issuer !== key) throw new BadRequestException('unknown or expired sign-in request');
        const config = await this.configuration(key);
        const tokens = await client.authorizationCodeGrant(config, callbackUrl, {
            pkceCodeVerifier: pending.codeVerifier,
            expectedState: state,
            expectedNonce: pending.nonce,
        });
        const claims = tokens.claims();
        const email = claims?.email;
        if (!claims || typeof email !== 'string' || claims.email_verified !== true) {
            throw new BadRequestException('the provider did not supply a verified email address');
        }
        return { provider: key, subject: claims.sub, email };
    }

    private configuration(key: string): Promise<client.Configuration> {
        const issuer = this.issuers.get(key);
        if (!issuer) throw new NotFoundException('unknown identity provider');
        let configuration = this.configurations.get(key);
        if (!configuration) {
            configuration = client.discovery(new URL(issuer.issuerUrl), issuer.clientId, issuer.clientSecret);
            this.configurations.set(key, configuration);
            // A failed discovery is not cached; the next attempt tries again.
            configuration.catch(() => this.configurations.delete(key));
        }
        return configuration;
    }

    private async remember(state: string, pending: PendingAuth): Promise<void> {
        if (this.redis.status !== 'ready') await this.redis.connect();
        await this.redis.set(`oidc:${state}`, JSON.stringify(pending), 'EX', OIDC_STATE_TTL_S);
    }

    /** Reads and deletes in one step: a state is accepted once. */
    private async forget(state: string): Promise<PendingAuth | null> {
        if (this.redis.status !== 'ready') await this.redis.connect();
        const raw = await this.redis.getdel(`oidc:${state}`);
        return raw ? (JSON.parse(raw) as PendingAuth) : null;
    }
}

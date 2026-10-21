import { generateKeyPairSync } from 'node:crypto';
import type {
    DelegatedToken,
    GoogleDelegationPort,
    ServiceAccountKey,
} from '../../src/mail-accounts/google-delegation.port';
import { GoogleOAuthError } from '../../src/mail-accounts/google-oauth.port';
import { assertNoOpenTransaction } from '../../src/infra/transaction-scope';
import type { FakeGoogleOAuth } from './fake-google-oauth';

/**
 * An in-memory Workspace for domain-wide delegation (#225): no network, ever. It enforces what Google
 * does — the client ID must be authorised in the "Admin console" for every scope asked for
 * (`unauthorized_client` otherwise), and the subject must be a user in the Workspace (`invalid_grant`).
 * Tokens come from the fake OAuth, so the fake Gmail and Calendar resolve them to the subject's mailbox.
 */
export class FakeGoogleDelegation implements GoogleDelegationPort {
    private readonly authorised = new Map<string, Set<string>>();
    private readonly users = new Set<string>();
    readonly mints: { clientId: string; subject: string; scopes: string[] }[] = [];

    constructor(private readonly oauth: FakeGoogleOAuth) {}

    /** The Admin console's domain-wide delegation entry for a client ID. */
    authorise(clientId: string, scopes: readonly string[]): void {
        this.authorised.set(clientId, new Set(scopes));
    }

    /** Users in the Workspace; only they can be a token's subject. */
    addUsers(...emails: string[]): void {
        for (const e of emails) this.users.add(e.toLowerCase());
    }

    mint(key: ServiceAccountKey, subject: string, scopes: readonly string[]): Promise<DelegatedToken> {
        assertNoOpenTransaction('Google delegation mint');
        this.mints.push({ clientId: key.clientId, subject, scopes: [...scopes] });
        const allowed = this.authorised.get(key.clientId);
        if (!allowed || scopes.some((s) => !allowed.has(s))) {
            return Promise.reject(new GoogleOAuthError('unauthorized_client', 401, 'delegated token refused (401)'));
        }
        if (!this.users.has(subject)) {
            return Promise.reject(new GoogleOAuthError('invalid_grant', 400, 'delegated token refused (400)'));
        }
        return Promise.resolve({
            accessToken: this.oauth.issueDelegated(key.clientId, subject, scopes),
            expiresInS: 3600,
        });
    }
}

/** A service account JSON key as Google Cloud downloads it, with a real RSA key so it parses. */
export function serviceAccountKeyJson(clientId: string, clientEmail: string): string {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    return JSON.stringify({
        type: 'service_account',
        project_id: 'byline-test',
        private_key_id: `kid${clientId}abcd`,
        private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
        client_email: clientEmail,
        client_id: clientId,
        token_uri: 'https://oauth2.googleapis.com/token',
    });
}

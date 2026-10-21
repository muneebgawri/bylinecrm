/**
 * Google Workspace domain-wide delegation (#225), behind one interface: a service account's JWT grant
 * (RFC 7523) with `sub` set to the member whose mailbox and calendar are read. The HTTP adapter
 * (`google-delegation.http.ts`) is the only code that signs or sends an assertion; tests bind a fake
 * (`test/support/fake-google-delegation.ts`). Failures are `GoogleOAuthError`s, as the OAuth port's are:
 * `unauthorized_client` — the Admin console does not authorise the client ID for a scope asked for;
 * `invalid_grant` — Google refused the subject (not in the Workspace, suspended) or the key.
 */

/** The parts of a service account's JSON key the grant needs, decrypted for the length of one call. */
export interface ServiceAccountKey {
    clientEmail: string;
    /** The numeric client ID the Admin console's domain-wide delegation entry names. */
    clientId: string;
    privateKey: string;
    privateKeyId: string;
}

/** An access token for one member, minted by the service account. */
export interface DelegatedToken {
    accessToken: string;
    /** Seconds the token is valid for, from now. */
    expiresInS: number;
}

export interface GoogleDelegationPort {
    /** An access token for `subject` carrying exactly `scopes`; refused whole if any scope is not authorised. */
    mint(key: ServiceAccountKey, subject: string, scopes: readonly string[]): Promise<DelegatedToken>;
}

/** Injection token for the port. */
export const GOOGLE_DELEGATION_PORT = Symbol('GOOGLE_DELEGATION_PORT');

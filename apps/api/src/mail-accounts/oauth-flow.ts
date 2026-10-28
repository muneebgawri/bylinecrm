import { createHash, randomBytes } from 'node:crypto';
import {
    GMAIL_BROAD_SCOPE,
    GMAIL_SCOPES,
    SERVICE_MAILBOX_SCOPES,
    type MailboxConnectResult,
    type MailboxPurpose,
} from '@bylinecrm/shared';
import { CONNECT_RANDOM_BYTES, GOOGLE_ENDPOINTS } from './mail-accounts.constants';

/** An unguessable token: a connect `state`, a PKCE verifier. base64url, no padding. */
export function randomToken(bytes = CONNECT_RANDOM_BYTES): string {
    return randomBytes(bytes).toString('base64url');
}

/** PKCE `S256` (RFC 7636 §4.2): base64url of the SHA-256 of the verifier. */
export function codeChallengeS256(verifier: string): string {
    return createHash('sha256').update(verifier).digest('base64url');
}

/**
 * The URL a person is sent to so they can grant `scopes` — a mailbox's two narrow Gmail scopes, or
 * Postmaster Tools' (#129) — to the workspace's own client. `access_type=offline` and
 * `prompt=consent` make Google return a refresh token every time; `include_granted_scopes=true`
 * asks Google to report every scope this client already holds for the account, so a broad grant
 * made earlier cannot hide behind a narrow request.
 */
export function authorizeUrl(input: {
    clientId: string;
    redirectUri: string;
    state: string;
    codeChallenge: string;
    scopes: readonly string[];
}): URL {
    const url = new URL(GOOGLE_ENDPOINTS.authorize);
    url.searchParams.set('client_id', input.clientId);
    url.searchParams.set('redirect_uri', input.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', input.scopes.join(' '));
    url.searchParams.set('state', input.state);
    url.searchParams.set('code_challenge', input.codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent');
    url.searchParams.set('include_granted_scopes', 'true');
    return url;
}

/**
 * The scopes a mailbox of this purpose cannot work without — the one answer for a connect, a refresh and a check. A
 * service inbox is read, never sent from (SVC-1), so reading is all it needs; holding it to the send scope as well
 * moved both production service inboxes to `reconnect_needed` on their first refresh (PNW-960). A personal mailbox's
 * calendar scope is optional, so it is not required here.
 */
export function requiredScopes(purpose: MailboxPurpose): readonly string[] {
    return purpose === 'service' ? SERVICE_MAILBOX_SCOPES : GMAIL_SCOPES;
}

/**
 * Whether a grant is one the service will hold: every scope it asked for (`required`:
 * `requiredScopes` for a mailbox), and never full mailbox access.
 */
export type GrantAssessment =
    | { ok: true }
    | { ok: false; result: Extract<MailboxConnectResult, 'scope_too_broad' | 'scope_missing'>; detail: string };

export function assessGrant(scopes: readonly string[], required: readonly string[]): GrantAssessment {
    if (scopes.includes(GMAIL_BROAD_SCOPE)) {
        return { ok: false, result: 'scope_too_broad', detail: `the grant includes ${GMAIL_BROAD_SCOPE}` };
    }
    const missing = required.filter((scope) => !scopes.includes(scope));
    if (missing.length > 0) {
        return { ok: false, result: 'scope_missing', detail: `the grant lacks ${missing.join(', ')}` };
    }
    return { ok: true };
}

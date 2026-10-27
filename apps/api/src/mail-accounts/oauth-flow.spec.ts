import { GMAIL_BROAD_SCOPE, GMAIL_READONLY_SCOPE, GMAIL_SCOPES, GMAIL_SEND_SCOPE } from '@bylinecrm/shared';
import { describe, expect, it } from 'vitest';
import { GOOGLE_ENDPOINTS } from './mail-accounts.constants';
import { assessGrant, authorizeUrl, codeChallengeS256, randomToken, requiredScopes } from './oauth-flow';

describe('the connect request', () => {
    const url = authorizeUrl({
        clientId: '123-abc.apps.googleusercontent.com',
        redirectUri: 'https://crm.example/api/mail/oauth/callback',
        state: 'state-1',
        codeChallenge: 'challenge-1',
        scopes: GMAIL_SCOPES,
    });

    it("goes to Google's authorization endpoint", () => {
        expect(`${url.origin}${url.pathname}`).toBe(GOOGLE_ENDPOINTS.authorize);
    });

    it('asks for exactly the two narrow scopes, never full mailbox access', () => {
        const scopes = (url.searchParams.get('scope') ?? '').split(' ');
        expect(scopes).toEqual([...GMAIL_SCOPES]);
        expect(scopes).not.toContain(GMAIL_BROAD_SCOPE);
    });

    it('asks for a refresh token every time, with PKCE, and for the scopes already granted', () => {
        expect(Object.fromEntries(url.searchParams)).toMatchObject({
            client_id: '123-abc.apps.googleusercontent.com',
            redirect_uri: 'https://crm.example/api/mail/oauth/callback',
            response_type: 'code',
            state: 'state-1',
            code_challenge: 'challenge-1',
            code_challenge_method: 'S256',
            access_type: 'offline',
            prompt: 'consent',
            include_granted_scopes: 'true',
        });
    });
});

describe('PKCE and state', () => {
    it('a challenge is the base64url SHA-256 of its verifier: 43 characters, stable, distinct', () => {
        const verifier = randomToken();
        const challenge = codeChallengeS256(verifier);
        expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(codeChallengeS256(verifier)).toBe(challenge);
        expect(codeChallengeS256(randomToken())).not.toBe(challenge);
    });

    it('random tokens are long enough for RFC 7636 and never repeat', () => {
        const tokens = new Set(Array.from({ length: 50 }, () => randomToken()));
        expect(tokens.size).toBe(50);
        for (const t of tokens) expect(t.length).toBeGreaterThanOrEqual(43);
    });
});

describe('which grants are held', () => {
    it('both narrow scopes: held', () => {
        expect(assessGrant([GMAIL_SEND_SCOPE, GMAIL_READONLY_SCOPE], requiredScopes('personal'))).toEqual({ ok: true });
    });

    it('full mailbox access: refused, even alongside the narrow scopes', () => {
        const result = assessGrant(
            [GMAIL_SEND_SCOPE, GMAIL_READONLY_SCOPE, GMAIL_BROAD_SCOPE],
            requiredScopes('personal'),
        );
        expect(result).toMatchObject({ ok: false, result: 'scope_too_broad' });
    });

    it('a narrow scope missing: refused, naming it', () => {
        const result = assessGrant([GMAIL_SEND_SCOPE], requiredScopes('personal'));
        expect(result).toMatchObject({ ok: false, result: 'scope_missing' });
        expect(result.ok ? '' : result.detail).toContain(GMAIL_READONLY_SCOPE);
    });

    it('PNW-960: a service inbox needs only to read — the read scope alone is held, and its absence is not', () => {
        expect(assessGrant([GMAIL_READONLY_SCOPE], requiredScopes('service'))).toEqual({ ok: true });
        expect(assessGrant([], requiredScopes('service'))).toMatchObject({ ok: false, result: 'scope_missing' });
        expect(assessGrant([GMAIL_READONLY_SCOPE, GMAIL_BROAD_SCOPE], requiredScopes('service'))).toMatchObject({
            ok: false,
            result: 'scope_too_broad',
        });
    });
});

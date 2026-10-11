import type { Request } from 'express';

/** A person, signed in with a session cookie. */
export interface UserPrincipal {
    kind: 'user';
    userId: string;
    sessionId: string;
    /** Whether the person's address is verified (#93); read with the session, no extra query. */
    emailVerified: boolean;
}

/** A machine, authenticated with an API key; the key belongs to exactly one workspace. */
export interface ApiKeyPrincipal {
    kind: 'apiKey';
    apiKeyId: string;
    workspaceId: string;
    roleId: string;
}

export type Principal = UserPrincipal | ApiKeyPrincipal;

/** The request, once the auth guard has looked at it. */
export interface AuthenticatedRequest extends Request {
    principal?: Principal;
}

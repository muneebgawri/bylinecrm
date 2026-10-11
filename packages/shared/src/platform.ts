/**
 * Who may create a workspace, and the operator-level actions around it (P0-14). One vocabulary for
 * the API's environment schema, its routes and the web app's sign-in and sign-up pages.
 */

/**
 * How a new account and its first workspace may come into being.
 * - `closed` — nobody signs up; platform admins create workspaces and invite their owners.
 * - `invite` — sign-up needs a platform sign-up invitation for that address.
 * - `open` — anyone may sign up and create a workspace (a self-serve offering).
 *
 * Joining an existing workspace by a member invitation works in every mode: that is how people
 * get in when sign-up is closed.
 */
export const SIGNUP_MODES = ['closed', 'invite', 'open'] as const;
export type SignupMode = (typeof SIGNUP_MODES)[number];

/** The mode a deployment runs in when it says nothing: the safe one. */
export const DEFAULT_SIGNUP_MODE: SignupMode = 'closed';

/**
 * The page an invitation link opens, and the query parameters that tell it which kind:
 * `invite` carries a workspace member invitation (any mode), `signup` a platform sign-up
 * invitation (invite mode). The API builds links from its WEB_URL and the web app from its own
 * origin, both through `invitationUrl`, so the two can never point at different pages.
 */
export const INVITATION_PAGE = '/sign-up';
export const MEMBER_INVITE_PARAM = 'invite';
export const SIGNUP_INVITE_PARAM = 'signup';
export type InvitationKind = 'member' | 'signup';

export function invitationUrl(base: string, kind: InvitationKind, token: string): string {
    // String-built: this package compiles without DOM or Node globals, so `URL` is not in scope.
    const param = kind === 'member' ? MEMBER_INVITE_PARAM : SIGNUP_INVITE_PARAM;
    return `${base.replace(/\/+$/, '')}${INVITATION_PAGE}?${param}=${encodeURIComponent(token)}`;
}

/**
 * The pages a mailed single-use link opens (#93), and its query parameter. Built here so the API
 * (which mails the link) and the web app (which serves the page) cannot disagree.
 */
export const VERIFY_EMAIL_PAGE = '/verify-email';
export const RESET_PASSWORD_PAGE = '/reset-password';
export const FORGOT_PASSWORD_PAGE = '/forgot-password';
export const LINK_TOKEN_PARAM = 'token';

/** The verification or reset link for `token`, on the web app at `base`. */
export function mailedLinkUrl(
    base: string,
    page: typeof VERIFY_EMAIL_PAGE | typeof RESET_PASSWORD_PAGE,
    token: string,
): string {
    return `${base.replace(/\/+$/, '')}${page}?${LINK_TOKEN_PARAM}=${encodeURIComponent(token)}`;
}

/**
 * Where the API sends a browser whose provider sign-in it refused, and the query parameter that
 * carries the error code (P0-14): `/sign-in?error=signup.closed` when sign-up is not open and the
 * address has no account, no pending invitation and is not a platform admin's.
 */
export const SIGN_IN_PAGE = '/sign-in';
export const SIGN_IN_ERROR_PARAM = 'error';

/**
 * Operator-level events. They are not workspace domain events (`DOMAIN_EVENT_TYPES`): nothing on a
 * record's timeline and no workspace webhook concerns them, and the timeline and webhook
 * subscribers ignore any type outside that catalogue. Each one is also written to the
 * append-only `platform_audit` table in the same transaction as the change it records.
 */
export const PLATFORM_EVENT_TYPES = [
    'platform.workspace_created',
    'platform.signup_invite_created',
    'platform.admin_email_verified',
] as const;
export type PlatformEventType = (typeof PLATFORM_EVENT_TYPES)[number];

export interface PlatformEvent {
    type: PlatformEventType;
    /** The platform admin who acted, or `null` for an operator command run on the server. */
    actorUserId: string | null;
    /** ISO 8601, UTC. */
    occurredAt: string;
    /** What the action concerned, by id and address — never a token. */
    subject: { workspaceId?: string; email?: string };
}

import {
    DELEGATION_AUDIT_ACTIONS,
    DELEGATION_MEMBER_STATES,
    MAILBOX_CONNECT_RESULTS,
    MAILBOX_CREDENTIAL_SOURCES,
    MAILBOX_PURPOSES,
    MAILBOX_TRANSPORTS,
    MAILBOX_STATUSES,
    OAUTH_CHECK_OUTCOMES,
} from '@bylinecrm/shared';
import { z } from 'zod';
import { dateTime, id, named } from '../openapi/responses';

/**
 * Mail accounts (P2-1) as the API returns them. No schema here has a field for a token or a
 * secret: the absence is the guarantee, and a cross-tenant test checks every response body.
 */

const checkStep = z.object({
    outcome: z.enum(OAUTH_CHECK_OUTCOMES),
    message: z.string().meta({ description: 'What the step found, safe to show.' }),
});

export const oauthClientCheck = named(
    'GoogleOAuthClientCheck',
    z.object({
        checkedAt: dateTime,
        format: checkStep.meta({ description: 'The client ID has the shape of a Google web client ID.' }),
        credentials: checkStep.meta({ description: 'Google knows the client ID and accepts the secret.' }),
        redirectUri: checkStep.meta({
            description:
                'The redirect URI is registered. Usually `unverified` until a mailbox connects: Google checks it only when a person signs in.',
        }),
    }),
);

export const oauthClientView = named(
    'GoogleOAuthClient',
    z.object({
        configured: z.boolean(),
        clientId: z.string().nullable(),
        clientSecretLast4: z.string().nullable().meta({ description: 'The only part of the secret ever shown.' }),
        redirectUri: z.url().meta({ description: 'Register exactly this in Google Cloud.' }),
        scopes: z
            .array(z.string())
            .meta({ description: 'Allow exactly these on the consent screen; nothing broader.' }),
        verifiedAt: dateTime.nullable().meta({ description: 'When a mailbox first connected through this client.' }),
        lastCheck: oauthClientCheck.nullable(),
        liveMailboxes: z
            .number()
            .int()
            .meta({ description: 'Mailboxes connected through this client and not disconnected.' }),
        configuredBy: id.nullable(),
        updatedAt: dateTime.nullable(),
    }),
);

/**
 * What any member may know about the workspace's Google setup (doc 50 §E): whether it is there and
 * proven, and what Google will show. Never the client ID or anything about the secret.
 */
export const oauthClientStatus = named(
    'GoogleOAuthClientStatus',
    z.object({
        configured: z.boolean(),
        verified: z.boolean().meta({ description: 'A mailbox has connected through the client.' }),
        redirectUri: z.url(),
        scopes: z.array(z.string()),
    }),
);

const mailboxError = z.object({
    code: z.string().meta({ description: 'Why the mailbox stopped: `invalid_grant`, `scope_missing`, …' }),
    message: z.string(),
    at: dateTime,
});

export const mailboxView = named(
    'Mailbox',
    z.object({
        id,
        ownerMemberId: id,
        email: z.string(),
        label: z.string().nullable(),
        purpose: z.enum(MAILBOX_PURPOSES).meta({ description: 'Fixed when the mailbox connects.' }),
        transport: z.enum(MAILBOX_TRANSPORTS).meta({
            description: 'How its mail leaves: its Gmail grant, or SMTP2Go (TRANS-1; pool mailboxes only).',
        }),
        status: z.enum(MAILBOX_STATUSES),
        credentialSource: z.enum(MAILBOX_CREDENTIAL_SOURCES).meta({
            description:
                "`delegation`: synced and sent through the workspace's Google Workspace service account (#225), not the member's own grant.",
        }),
        grantedScopes: z.array(z.string()),
        lastError: mailboxError.nullable(),
        connectedAt: dateTime.nullable(),
        createdAt: dateTime,
        updatedAt: dateTime,
    }),
);

export const connectStart = named(
    'MailboxConnectStart',
    z.object({
        authorizeUrl: z.url().meta({ description: "Send the browser here; Google returns it to the API's callback." }),
        expiresAt: dateTime.meta({ description: 'The request must complete before this.' }),
    }),
);

export const mailboxDisconnected = named(
    'MailboxDisconnected',
    z.object({
        mailbox: mailboxView,
        revoked: z.boolean().meta({
            description: 'Whether Google confirmed the grant was revoked. The stored tokens are gone either way.',
        }),
    }),
);

export const mailboxCheck = named(
    'MailboxCheck',
    z.object({
        mailbox: mailboxView,
        ok: z.boolean(),
        problem: z.enum(['reconnect_needed', 'scope_missing', 'scope_too_broad']).nullable(),
    }),
);

/** Documented for the web app: the values the callback's redirect may carry in `?connect=`. */
export const mailboxConnectResult = named('MailboxConnectResult', z.enum(MAILBOX_CONNECT_RESULTS));

// ── Google Workspace delegation (#225) ──────────────────────────────────────────────────────

export const delegationCheck = named(
    'GoogleWorkspaceDelegationCheck',
    z.object({
        checkedAt: dateTime,
        subject: z.string().meta({ description: 'The address a token was minted for: the admin who ran the check.' }),
        scopes: z.array(
            z.object({
                scope: z.string(),
                granted: z.boolean(),
                error: z
                    .string()
                    .nullable()
                    .meta({ description: "Google's error name when refused (`unauthorized_client`, …)." }),
            }),
        ),
    }),
);

export const delegationView = named(
    'GoogleWorkspaceDelegation',
    z.object({
        configured: z
            .boolean()
            .meta({ description: 'A service account key is stored. The key itself is never returned.' }),
        clientEmail: z.string().nullable(),
        clientId: z
            .string()
            .nullable()
            .meta({ description: "The service account's client ID: what the Admin console's delegation entry names." }),
        privateKeyIdLast4: z.string().nullable(),
        allowedDomains: z.array(z.string()),
        scopes: z
            .array(z.string())
            .meta({ description: 'Authorise exactly these for the client ID in the Admin console; nothing broader.' }),
        grantedScopes: z.array(z.string()).meta({ description: 'What the last check found authorised.' }),
        active: z.boolean().meta({
            description: 'Configured, with an allowed domain, and the last check found Gmail read authorised.',
        }),
        lastCheck: delegationCheck.nullable(),
        delegatedMailboxes: z
            .number()
            .int()
            .meta({ description: 'Mailboxes syncing through the service account now.' }),
        updatedAt: dateTime.nullable(),
    }),
);

export const delegationMember = named(
    'GoogleWorkspaceDelegationMember',
    z.object({
        memberId: id,
        name: z.string().nullable(),
        email: z.string(),
        state: z.enum(DELEGATION_MEMBER_STATES).meta({
            description:
                '`delegated` — synced through the service account (once delegation is active); `own_connection` — their own OAuth connection wins; `excluded` by an admin; `outside_domains`.',
        }),
        excluded: z.boolean(),
        mailboxId: id.nullable().meta({ description: 'Their delegated mailbox, when there is one.' }),
        mailboxStatus: z.enum(MAILBOX_STATUSES).nullable(),
    }),
);

export const delegationAuditEntry = named(
    'GoogleWorkspaceDelegationAuditEntry',
    z.object({
        id,
        action: z.enum(DELEGATION_AUDIT_ACTIONS),
        actorMemberId: id.nullable().meta({ description: 'Null for the sync worker.' }),
        subjectMemberId: id.nullable(),
        mailboxId: id.nullable(),
        detail: z.record(z.string(), z.unknown()),
        createdAt: dateTime,
    }),
);

export type DelegationView = z.output<typeof delegationView>;
export type DelegationCheck = z.output<typeof delegationCheck>;
export type DelegationMember = z.output<typeof delegationMember>;
export type DelegationAuditEntry = z.output<typeof delegationAuditEntry>;
export type OAuthClientView = z.output<typeof oauthClientView>;
export type OAuthClientCheck = z.output<typeof oauthClientCheck>;
export type OAuthClientStatus = z.output<typeof oauthClientStatus>;
export type MailboxView = z.output<typeof mailboxView>;
export type ConnectStart = z.output<typeof connectStart>;
export type MailboxDisconnected = z.output<typeof mailboxDisconnected>;
export type MailboxCheck = z.output<typeof mailboxCheck>;

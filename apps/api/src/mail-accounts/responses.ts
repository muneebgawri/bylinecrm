import { MAILBOX_CONNECT_RESULTS, MAILBOX_PURPOSES, MAILBOX_STATUSES, OAUTH_CHECK_OUTCOMES } from '@bylinecrm/shared';
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
        status: z.enum(MAILBOX_STATUSES),
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

export type OAuthClientView = z.output<typeof oauthClientView>;
export type OAuthClientCheck = z.output<typeof oauthClientCheck>;
export type MailboxView = z.output<typeof mailboxView>;
export type ConnectStart = z.output<typeof connectStart>;
export type MailboxDisconnected = z.output<typeof mailboxDisconnected>;
export type MailboxCheck = z.output<typeof mailboxCheck>;

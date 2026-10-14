import { CAPABILITIES, RECORD_SCOPES, SIGNUP_MODES } from '@bylinecrm/shared';
import { z } from 'zod';
import { dateTime, id, named } from '../openapi/responses';

/** The caller, the workspaces and the people in them (P0-3), as the API returns them. */

export const userView = named('User', z.object({ id, email: z.email(), emailVerified: z.boolean() }));

/** The person's own profile (`/api/me/profile`): the name every workspace shows them under. */
export const profileView = named(
    'Profile',
    z.object({
        email: z.email(),
        displayName: z.string().nullable(),
        completed: z.boolean().meta({
            description: 'The person has confirmed their name; until then the app asks once, after sign-up.',
        }),
    }),
);

export const workspaceView = named('Workspace', z.object({ id, slug: z.string(), name: z.string() }));

export const signedUp = named('SignedUp', z.object({ user: userView, workspace: workspaceView }));
export const signedIn = named('SignedIn', z.object({ user: userView }));
export const authProviders = named(
    'AuthProviders',
    z.object({
        providers: z.array(z.string()).meta({ description: 'Sign-in providers this server offers.' }),
        signup: z.enum(SIGNUP_MODES).meta({
            description:
                'Who may sign up (P0-14): `closed` — nobody, join by invitation; `invite` — with a sign-up invitation; `open` — anyone.',
        }),
    }),
);

/** What a workspace invitation is for, shown to the person holding its token before they accept. */
export const invitePreview = named(
    'InvitePreview',
    z.object({ email: z.email(), workspaceName: z.string(), expiresAt: dateTime }),
);

/** The caller's standing in one workspace — the guard's decision, read back (`GET …/me`). */
export const standingView = named(
    'Standing',
    z.object({
        workspaceId: id,
        memberId: id.nullable().meta({ description: 'The seat, when the caller is a person; `null` for a key.' }),
        userId: id.nullable(),
        apiKeyId: id.nullable().meta({ description: 'The key, when the caller is a machine; `null` for a person.' }),
        roleId: id.nullable(),
        roleName: z.string().nullable(),
        recordScope: z.enum(RECORD_SCOPES),
        capabilities: z.array(z.enum(CAPABILITIES)),
    }),
);

export const memberView = named(
    'Member',
    z.object({
        id,
        userId: id,
        email: z.email(),
        displayName: z.string().nullable(),
        roleId: id,
        roleName: z.string(),
        createdAt: dateTime,
        hasSignedIn: z.boolean().meta({
            description:
                'False for an account the Twenty importer made (#184) that nobody has signed in to yet: it has no password and no verified address. An admin sends it the invitation from Members.',
        }),
    }),
);

export const memberSummaryView = named(
    'MemberSummary',
    z.object({
        memberId: id,
        name: z.string().nullable(),
        leftAt: dateTime.nullable().meta({
            description:
                'When the member was removed (#147); null for a member in the workspace. A picker leaves a removed member out; a row they left behind still names them.',
        }),
    }),
);

export const roleView = named(
    'Role',
    z.object({
        id,
        name: z.string(),
        isSystem: z.boolean(),
        recordScope: z.enum(RECORD_SCOPES),
        capabilities: z.array(z.enum(CAPABILITIES)),
    }),
);

export const apiKeyView = named(
    'ApiKey',
    z.object({
        id,
        name: z.string(),
        prefix: z.string(),
        roleId: id,
        createdAt: dateTime,
        lastUsedAt: dateTime.nullable(),
        revokedAt: dateTime.nullable(),
    }),
);
export const createdApiKey = named(
    'CreatedApiKey',
    z.object({ key: apiKeyView, secret: z.string().meta({ description: 'Shown once; store it now.' }) }),
);

export const inviteView = named(
    'Invite',
    z.object({ id, email: z.email(), roleId: id, expiresAt: dateTime, acceptedAt: dateTime.nullable() }),
);
export const createdInvite = named(
    'CreatedInvite',
    z.object({ invite: inviteView, token: z.string().meta({ description: 'The invitation token; shown once.' }) }),
);

export type UserView = z.output<typeof userView>;
export type ProfileView = z.output<typeof profileView>;
export type WorkspaceView = z.output<typeof workspaceView>;
export type AuthProvidersView = z.output<typeof authProviders>;
export type InvitePreviewView = z.output<typeof invitePreview>;
export type StandingView = z.output<typeof standingView>;
export type MemberView = z.output<typeof memberView>;
export type MemberSummaryView = z.output<typeof memberSummaryView>;
export type RoleView = z.output<typeof roleView>;
export type ApiKeyView = z.output<typeof apiKeyView>;
export type InviteView = z.output<typeof inviteView>;

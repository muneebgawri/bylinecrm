import { CAPABILITIES, RECORD_SCOPES } from '@bylinecrm/shared';
import { z } from 'zod';
import { dateTime, id, named } from '../openapi/responses';

/** The caller, the workspaces and the people in them (P0-3), as the API returns them. */

export const userView = named('User', z.object({ id, email: z.email(), emailVerified: z.boolean() }));

export const workspaceView = named('Workspace', z.object({ id, slug: z.string(), name: z.string() }));

export const signedUp = named('SignedUp', z.object({ user: userView, workspace: workspaceView }));
export const signedIn = named('SignedIn', z.object({ user: userView }));
export const authProviders = named(
    'AuthProviders',
    z.object({ providers: z.array(z.string()).meta({ description: 'Sign-in providers this server offers.' }) }),
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
        roleId: id,
        roleName: z.string(),
        createdAt: dateTime,
    }),
);

export const memberSummaryView = named('MemberSummary', z.object({ memberId: id, name: z.string().nullable() }));

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
export type WorkspaceView = z.output<typeof workspaceView>;
export type StandingView = z.output<typeof standingView>;
export type MemberView = z.output<typeof memberView>;
export type MemberSummaryView = z.output<typeof memberSummaryView>;
export type RoleView = z.output<typeof roleView>;
export type ApiKeyView = z.output<typeof apiKeyView>;
export type InviteView = z.output<typeof inviteView>;

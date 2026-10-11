import { SIGNUP_MODES } from '@bylinecrm/shared';
import { z } from 'zod';
import { dateTime, id, named } from '../openapi/responses';
import { workspaceView } from '../workspace/responses';

/** The platform routes (P0-14), as the API returns them. */

export const platformAccess = named(
    'PlatformAccess',
    z.object({
        platformAdmin: z.boolean().meta({
            description: 'Whether the caller may use the platform routes: a verified address in PLATFORM_ADMIN_EMAILS.',
        }),
        signupMode: z.enum(SIGNUP_MODES),
    }),
);

/** An invitation link, shown once: whoever holds the token can use it. */
export const platformInvite = named(
    'PlatformInvite',
    z.object({
        email: z.email(),
        url: z.string().meta({ description: 'The link to send; built from the server’s WEB_URL.' }),
        token: z.string().meta({ description: 'The invitation token; shown once.' }),
        expiresAt: dateTime,
    }),
);

export const platformWorkspace = named(
    'PlatformWorkspace',
    z.object({
        id,
        slug: z.string(),
        name: z.string(),
        createdAt: dateTime,
        memberCount: z.number().int(),
        pendingInvites: z
            .array(z.object({ email: z.email(), expiresAt: dateTime }))
            .meta({ description: 'Invitations to the admin role not yet accepted (the owner’s, until they join).' }),
    }),
);

export const createdPlatformWorkspace = named(
    'CreatedPlatformWorkspace',
    z.object({ workspace: workspaceView, invite: platformInvite }),
);

export type PlatformAccessView = z.output<typeof platformAccess>;
export type PlatformInviteView = z.output<typeof platformInvite>;
export type PlatformWorkspaceView = z.output<typeof platformWorkspace>;
export type CreatedPlatformWorkspaceView = z.output<typeof createdPlatformWorkspace>;

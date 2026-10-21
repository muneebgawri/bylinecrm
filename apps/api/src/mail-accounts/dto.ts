import { MAILBOX_PURPOSES } from '@bylinecrm/shared';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import {
    DELEGATION_DOMAINS_MAX,
    SERVICE_ACCOUNT_KEY_MAX,
    GOOGLE_CLIENT_ID_MAX,
    GOOGLE_CLIENT_ID_PATTERN,
    GOOGLE_CLIENT_SECRET_MAX,
    MAILBOX_LABEL_MAX,
} from './mail-accounts.constants';

/** The workspace's own OAuth client, as an admin pastes it from Google Cloud. */
export class PutOAuthClientDto extends createZodDto(
    z.object({
        clientId: z
            .string()
            .trim()
            .max(GOOGLE_CLIENT_ID_MAX)
            .regex(GOOGLE_CLIENT_ID_PATTERN, 'not a Google web client ID (…apps.googleusercontent.com)'),
        clientSecret: z.string().trim().min(1).max(GOOGLE_CLIENT_SECRET_MAX),
    }),
) {}

export class ConnectMailboxDto extends createZodDto(z.object({ purpose: z.enum(MAILBOX_PURPOSES) })) {}

/**
 * What can change on a mailbox. `purpose` is accepted only to be refused when it differs: a
 * mailbox's purpose is fixed when it connects, and changing it means disconnecting and connecting
 * again (FR-CRMS-1) — the refusal says so rather than a validator calling the field unknown.
 */
export class UpdateMailboxDto extends createZodDto(
    z
        .object({
            label: z.string().trim().max(MAILBOX_LABEL_MAX).nullable(),
            purpose: z.enum(MAILBOX_PURPOSES),
        })
        .partial()
        .refine((body) => Object.keys(body).length > 0, { message: 'nothing to update' }),
) {}

/** What Google appends to the callback URL. Every field is optional: Google sends `code` or `error`. */
export class OAuthCallbackQueryDto extends createZodDto(
    z.object({
        state: z.string().max(200).optional(),
        code: z.string().max(2000).optional(),
        error: z.string().max(200).optional(),
        scope: z.string().max(2000).optional(),
    }),
) {}

/** A service account's JSON key (#225), as the file's text. Stored sealed; never returned. */
export class PutDelegationKeyDto extends createZodDto(
    z.object({ key: z.string().min(1).max(SERVICE_ACCOUNT_KEY_MAX) }),
) {}

const DOMAIN = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** The domains whose members sync through the service account (#225). */
export class PatchDelegationDto extends createZodDto(
    z.object({
        allowedDomains: z
            .array(z.string().trim().toLowerCase().regex(DOMAIN, 'not a domain name, like example.com'))
            .max(DELEGATION_DOMAINS_MAX),
    }),
) {}

/** An admin's per-member toggle (#225): an excluded member is never synced through the service account. */
export class PutDelegationMemberDto extends createZodDto(z.object({ excluded: z.boolean() })) {}

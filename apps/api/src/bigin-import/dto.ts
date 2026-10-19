import {
    BIGIN_IMPORT_MODES,
    BIGIN_IMPORT_OBJECTS,
    LIST_LIMIT_DEFAULT,
    LIST_LIMIT_MAX,
    TWENTY_SYNC_INTERVALS,
} from '@bylinecrm/shared';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * `PUT /import/bigin/settings` — the Zoho data centre's two URLs, the OAuth client and a refresh token
 * (Zoho's self-client grant). The secret and the token are write-only: an update may leave them out to
 * keep the stored ones.
 */
export class PutBiginImportSettingsDto extends createZodDto(
    z.object({
        accountsUrl: z.url({ error: 'Zoho’s accounts URL, e.g. https://accounts.zoho.com' }).trim().max(500),
        apiUrl: z.url({ error: 'Zoho’s API URL, e.g. https://www.zohoapis.com' }).trim().max(500),
        clientId: z.string().trim().min(8, 'the client id from Zoho’s API console').max(500),
        clientSecret: z.string().trim().min(8, 'the client secret from Zoho’s API console').max(500).optional(),
        refreshToken: z.string().trim().min(8, 'a refresh token for the Bigin scopes').max(2000).optional(),
        /** A self client's one-time grant code: traded for the refresh token on save, in place of `refreshToken`. */
        grantCode: z.string().trim().min(8, 'the code Zoho’s self client generated').max(2000).optional(),
    }),
) {}

/** `POST /import/bigin/runs` — everything, or what Bigin changed since each module's cursor; `createMembers` as #184. */
export class StartBiginImportDto extends createZodDto(
    z.object({
        mode: z.enum(BIGIN_IMPORT_MODES).default('changes'),
        createMembers: z.object({ roleId: z.uuid() }).optional(),
    }),
) {}

/** `GET /import/bigin/missing` — the mapped records Bigin deleted, one module or all, paged. */
export class ListBiginImportMissingDto extends createZodDto(
    z.object({
        object: z.enum(BIGIN_IMPORT_OBJECTS).optional(),
        limit: z.coerce.number().int().min(1).max(LIST_LIMIT_MAX).default(LIST_LIMIT_DEFAULT),
        cursor: z.string().optional(),
    }),
) {}

/** `PUT /import/bigin/sync` — how often a `changes` run starts on its own; `off` stops it. */
export class PutBiginImportSyncDto extends createZodDto(z.object({ interval: z.enum(TWENTY_SYNC_INTERVALS) })) {}

/** `GET /import/bigin/reuses` — Bigin Contacts reused for another person, newest first, paged. */
export class ListBiginContactReusesDto extends createZodDto(
    z.object({
        limit: z.coerce.number().int().min(1).max(LIST_LIMIT_MAX).default(LIST_LIMIT_DEFAULT),
        cursor: z.uuid().optional(),
    }),
) {}

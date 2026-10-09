import { BLOCKLIST_SCOPES, BLOCKLIST_VALUE_MAX } from '@bylinecrm/shared';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { MAIL_THREADS_LIMIT_DEFAULT, MAIL_THREADS_LIMIT_MAX } from './mail-sync.constants';

/** `GET /mail/threads?target=person:<id>` — the threads concerning one record. */
export class ListThreadsQueryDto extends createZodDto(
    z.object({
        target: z.string().meta({ description: '`person:<uuid>`, `company:<uuid>` or `opportunity:<uuid>`.' }),
        cursor: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(MAIL_THREADS_LIMIT_MAX).default(MAIL_THREADS_LIMIT_DEFAULT),
    }),
) {}

/** A blocklist entry to add: an address or `@domain`, for the caller alone or (admins) the workspace. */
export class CreateBlocklistEntryDto extends createZodDto(
    z.object({
        value: z.string().max(BLOCKLIST_VALUE_MAX),
        scope: z.enum(BLOCKLIST_SCOPES).default('personal'),
    }),
) {}

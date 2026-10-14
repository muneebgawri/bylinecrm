import {
    LIST_LIMIT_DEFAULT,
    LIST_LIMIT_MAX,
    TWENTY_IMPORT_MODES,
    TWENTY_IMPORT_OBJECTS,
    TWENTY_SYNC_INTERVALS,
} from '@bylinecrm/shared';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** `PUT /import/twenty/settings` — where the Twenty workspace is and the key that reads it. */
export class PutTwentyImportSettingsDto extends createZodDto(
    z.object({
        baseUrl: z.url({ error: 'the Twenty workspace URL, e.g. https://crm.example.com' }).trim().max(500),
        apiKey: z.string().trim().min(8, 'an API key from Twenty’s settings').max(2000),
    }),
) {}

/** `POST /import/twenty/runs` — everything, only what Twenty changed since the last successful run, or a reconcile pass (#156). */
export class StartTwentyImportDto extends createZodDto(
    z.object({ mode: z.enum(TWENTY_IMPORT_MODES).default('full') }),
) {}

/** `GET /import/twenty/missing` — the records a reconcile pass flagged, one object or all, paged. */
export class ListTwentyImportMissingDto extends createZodDto(
    z.object({
        object: z.enum(TWENTY_IMPORT_OBJECTS).optional(),
        limit: z.coerce.number().int().min(1).max(LIST_LIMIT_MAX).default(LIST_LIMIT_DEFAULT),
        cursor: z.string().optional(),
    }),
) {}

/** `PUT /import/twenty/sync` — how often the importer runs its `changes` mode on its own (#185); `off` stops it. */
export class PutTwentyImportSyncDto extends createZodDto(z.object({ interval: z.enum(TWENTY_SYNC_INTERVALS) })) {}

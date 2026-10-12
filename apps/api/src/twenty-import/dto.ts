import { TWENTY_IMPORT_MODES } from '@bylinecrm/shared';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** `PUT /import/twenty/settings` — where the Twenty workspace is and the key that reads it. */
export class PutTwentyImportSettingsDto extends createZodDto(
    z.object({
        baseUrl: z.url({ error: 'the Twenty workspace URL, e.g. https://crm.example.com' }).trim().max(500),
        apiKey: z.string().trim().min(8, 'an API key from Twenty’s settings').max(2000),
    }),
) {}

/** `POST /import/twenty/runs` — everything, or only what Twenty changed since the last successful run. */
export class StartTwentyImportDto extends createZodDto(
    z.object({ mode: z.enum(TWENTY_IMPORT_MODES).default('full') }),
) {}

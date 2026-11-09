import { CALL_DIRECTIONS, CALL_DISPOSITIONS } from '@bylinecrm/shared';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { richText as richTextSchema } from '../records/dto';

/** `PUT /integrations/quo`: the API key; saving it registers the webhook and matches users. */
export class PutQuoSettingsDto extends createZodDto(
    z.object({
        apiKey: z
            .string()
            .min(8)
            .max(500)
            .meta({ description: 'A Quo API key (Settings → API in Quo). Never shown back.' }),
    }),
) {}

/** `POST /calls`: a call logged from the Call panel. */
export class LogCallDto extends createZodDto(
    z.object({
        personId: z.uuid(),
        direction: z.enum(CALL_DIRECTIONS).default('outbound'),
        disposition: z.enum(CALL_DISPOSITIONS),
        startedAt: z.iso.datetime().optional().meta({ description: 'When the call started; now when left out.' }),
        durationSec: z
            .number()
            .int()
            .min(0)
            .max(24 * 3600)
            .nullable()
            .optional(),
        note: richTextSchema.optional().meta({ description: 'The call notes, as a note on the person.' }),
    }),
) {}

/** `PATCH /calls/:id`: the outcome and the notes; whatever is left out is kept. */
export class PatchCallDto extends createZodDto(
    z.object({
        disposition: z.enum(CALL_DISPOSITIONS).nullable().optional(),
        note: richTextSchema.optional(),
    }),
) {}

export class ListCallsQueryDto extends createZodDto(z.object({ personId: z.uuid() })) {}

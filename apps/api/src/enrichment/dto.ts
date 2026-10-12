import { ENRICHMENT_LIMITS, ENRICHMENT_SOURCES } from '@bylinecrm/shared';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const L = ENRICHMENT_LIMITS.reaskAfterDays;

/** `PUT /enrichment/settings`: how long an answer stands, and each source on or off. */
export class PutEnrichmentSettingsDto extends createZodDto(
    z.object({
        reaskAfterDays: z.number().int().min(L.min).max(L.max),
        sources: z.object(
            Object.fromEntries(ENRICHMENT_SOURCES.map((s) => [s, z.boolean()])) as Record<
                (typeof ENRICHMENT_SOURCES)[number],
                z.ZodBoolean
            >,
        ),
    }),
) {}

import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { BYLINE_ROUND_ROBIN_MAX, BYLINE_SECRET_MAX, BYLINE_SECRET_MIN } from './byline.constants';

/** `PUT /integrations/byline`: the webhook's secret, BylineAI's API, or both; whatever is left out is kept. */
export class PutBylineSettingsDto extends createZodDto(
    z.object({
        secret: z.string().min(BYLINE_SECRET_MIN).max(BYLINE_SECRET_MAX).optional().meta({
            description:
                'The secret BylineAI signs lead deliveries with (`BYLINE_WEBHOOK_SECRET`). Leave out to keep it.',
        }),
        baseUrl: z
            .url({ protocol: /^https?$/ })
            .max(200)
            .nullable()
            .optional()
            .meta({
                description:
                    'BylineAI’s address (BYL-2), `https://byline.example`; null unlinks its API. Leave out to keep.',
            }),
        apiKey: z.string().min(1).max(500).optional().meta({
            description: 'A BylineAI API key (`x-api-key`). Needed with a first address; leave out to keep it.',
        }),
        verifyWithByline: z.boolean().optional().meta({
            description: 'Verify addresses with BylineAI instead of the free layer alone.',
        }),
        roundRobinMemberIds: z.array(z.uuid()).max(BYLINE_ROUND_ROBIN_MAX).optional().meta({
            description: 'Members to deal leads at unowned companies to, in order. Leave out to keep the list.',
        }),
    }),
) {}

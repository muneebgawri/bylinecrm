import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { BYLINE_ROUND_ROBIN_MAX, BYLINE_SECRET_MAX, BYLINE_SECRET_MIN } from './byline.constants';

/** `PUT /integrations/byline`: the secret is needed the first time, and kept when left out. */
export class PutBylineSettingsDto extends createZodDto(
    z.object({
        secret: z.string().min(BYLINE_SECRET_MIN).max(BYLINE_SECRET_MAX).optional().meta({
            description:
                'The secret BylineAI signs lead deliveries with (`BYLINE_WEBHOOK_SECRET`). Leave out to keep it.',
        }),
        roundRobinMemberIds: z.array(z.uuid()).max(BYLINE_ROUND_ROBIN_MAX).optional().meta({
            description: 'Members to deal leads at unowned companies to, in order. Leave out to keep the list.',
        }),
    }),
) {}

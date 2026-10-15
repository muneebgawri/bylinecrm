import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { SLOTLINE_BASE_URL_MAX, SLOTLINE_SECRET_MAX, SLOTLINE_SECRET_MIN } from './slotline.constants';

/** `PUT /integrations/slotline` — the booking site and the secret its webhook signs with (required the first time). */
export class PutSlotlineSettingsDto extends createZodDto(
    z.object({
        baseUrl: z
            .url({ protocol: /^https$/ })
            .max(SLOTLINE_BASE_URL_MAX)
            .meta({ description: 'The booking site’s address, `https://bookings.example.com`.' }),
        secret: z
            .string()
            .min(SLOTLINE_SECRET_MIN)
            .max(SLOTLINE_SECRET_MAX)
            .optional()
            .meta({ description: 'The secret entered on the webhook in Slotline. Leave out to keep the current one.' }),
    }),
) {}

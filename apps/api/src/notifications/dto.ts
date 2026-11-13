import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** `POST /notifications/read`: the caller's notifications named, or — with no `ids` — every one. */
export class MarkNotificationsReadDto extends createZodDto(
    z.object({ ids: z.array(z.uuid()).min(1).max(200).optional() }),
) {}

/** `PUT /notification-settings`: the settings named change; any left out stay as they are. */
export class NotificationSettingsDto extends createZodDto(
    z
        .object({
            taskDigest: z.boolean(),
            notifyEmailReplies: z.boolean(),
            notifyEmailClicks: z.boolean(),
            notifyEmailOpens: z.boolean(),
            notifySound: z.boolean(),
        })
        .partial(),
) {}

import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** `POST /notifications/read`: the caller's notifications named, or — with no `ids` — every one. */
export class MarkNotificationsReadDto extends createZodDto(
    z.object({ ids: z.array(z.uuid()).min(1).max(200).optional() }),
) {}

/** `PUT /notification-settings`. */
export class NotificationSettingsDto extends createZodDto(z.object({ taskDigest: z.boolean() })) {}

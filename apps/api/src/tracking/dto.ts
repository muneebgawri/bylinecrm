import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** A hostname as the database checks it: labels of letters, digits and hyphens, at least two of them. */
export const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** `PUT /tracking/domain`: the short-link domain, compared lower case. */
export class PutTrackingDomainDto extends createZodDto(
    z.object({
        domain: z.string().trim().toLowerCase().max(253).regex(HOSTNAME, 'a hostname such as go.example.com'),
    }),
) {}

/** TRACK-2 `PATCH /tracking/policy`: any of the settings; `smtp2goApiKey: null` removes the key. */
export class PatchTrackingPolicyDto extends createZodDto(
    z
        .object({
            provider: z.enum(['builtin', 'smtp2go']),
            trackOpens: z.boolean(),
            trackClicks: z.boolean(),
            trackPersonalMail: z.boolean(),
            gmailReplyNotices: z.boolean(),
            smtp2goApiKey: z.string().trim().min(10).max(200).nullable(),
        })
        .partial(),
) {}

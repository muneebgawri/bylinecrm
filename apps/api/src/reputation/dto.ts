import { REPUTATION_LIMITS } from '@bylinecrm/shared';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const int = (b: { min: number; max: number }) => z.number().int().min(b.min).max(b.max);
const L = REPUTATION_LIMITS;

/** `PUT /reputation/settings` — every threshold, validated against the bounds the database checks (REP-1). */
export class UpdateReputationSettingsDto extends createZodDto(
    z
        .object({
            dailyNewRecipients: int(L.dailyNewRecipients),
            hourlyNewRecipients: int(L.hourlyNewRecipients),
            poolHourlyCap: int(L.poolHourlyCap),
            nearDuplicateThreshold: int(L.nearDuplicateThreshold),
            nearDuplicateDistance: int(L.nearDuplicateDistance),
            subjectRepeatThreshold: int(L.subjectRepeatThreshold),
            primaryDomain: z
                .string()
                .trim()
                .toLowerCase()
                .regex(
                    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
                    'a domain, like example.com',
                )
                .nullable(),
        })
        .superRefine((v, ctx) => {
            if (v.hourlyNewRecipients > v.dailyNewRecipients) {
                ctx.addIssue({ code: 'custom', path: ['hourlyNewRecipients'], message: 'at most the daily budget' });
            }
        }),
) {}

import {
    EMAIL_VERIFICATION_REASONS,
    EMAIL_VERIFICATION_RESULTS,
    type EmailVerificationSettingsView,
    type EmailVerificationView,
    type PersonVerificationView,
} from '@bylinecrm/shared';
import { z } from 'zod';
import { named } from '../openapi/responses';

/** Email verification (P3-5), as the API returns it. */

const isoTime = z.iso.datetime();

export const emailVerificationView = named(
    'EmailVerification',
    z.object({
        address: z.string(),
        result: z.enum(EMAIL_VERIFICATION_RESULTS),
        reason: z.enum(EMAIL_VERIFICATION_REASONS),
        message: z.string().meta({ description: 'Why, in words, naming the domain.' }),
        source: z.string().meta({ description: 'The verifier that answered: `free`, or a vendor adapter.' }),
        verifiedAt: isoTime,
        stale: z
            .boolean()
            .meta({ description: 'Older than the workspace’s age, or unknown: found again at the next check.' }),
    }),
);

export const personVerificationView = named(
    'PersonVerification',
    z.object({
        address: z.string().nullable().meta({ description: 'The person’s primary address; null when they have none.' }),
        verification: emailVerificationView.nullable(),
    }),
);

export const emailVerificationSettingsView = named(
    'EmailVerificationSettings',
    z.object({
        maxAgeDays: z.number().int(),
        isDefault: z.boolean(),
        updatedAt: isoTime.nullable(),
    }),
);

type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;
export type VerificationTypeChecks = [
    Assert<Same<z.output<typeof emailVerificationView>, EmailVerificationView>>,
    Assert<Same<z.output<typeof personVerificationView>, PersonVerificationView>>,
    Assert<Same<z.output<typeof emailVerificationSettingsView>, EmailVerificationSettingsView>>,
];

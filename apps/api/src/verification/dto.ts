import { EMAIL_VERIFICATION_LIMITS } from '@bylinecrm/shared';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const L = EMAIL_VERIFICATION_LIMITS.maxAgeDays;

/** `PUT /outreach/verification`: how many days a result stands before it is found again (FR-CRMS-16). */
export class PutVerificationSettingsDto extends createZodDto(
    z.object({ maxAgeDays: z.number().int().min(L.min).max(L.max) }),
) {}

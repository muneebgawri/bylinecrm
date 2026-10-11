import {
    LIST_LIMIT_DEFAULT,
    LIST_LIMIT_MAX,
    SUPPRESSION_ADDRESS_MAX,
    SUPPRESSION_NOTE_MAX,
    SUPPRESSION_REASONS,
} from '@bylinecrm/shared';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** `GET /suppressions` — newest first; `q` matches part of an address, `reason` narrows to one reason. */
export class ListSuppressionsQueryDto extends createZodDto(
    z.object({
        q: z.string().trim().min(1).max(SUPPRESSION_ADDRESS_MAX).optional(),
        reason: z.enum(SUPPRESSION_REASONS).optional(),
        cursor: z.string().min(1).optional(),
        limit: z.coerce.number().int().min(1).max(LIST_LIMIT_MAX).default(LIST_LIMIT_DEFAULT),
    }),
) {}

/** An address a member suppresses by hand (reason `manual`). */
export class CreateSuppressionDto extends createZodDto(
    z.object({
        address: z.string().max(SUPPRESSION_ADDRESS_MAX * 2),
        note: z.string().trim().max(SUPPRESSION_NOTE_MAX).optional(),
    }),
) {}

/** Lifting an entry says why. */
export class RemoveSuppressionDto extends createZodDto(
    z.object({
        note: z.string().trim().min(1, 'say why the entry is lifted').max(SUPPRESSION_NOTE_MAX),
    }),
) {}

export type ListSuppressionsQuery = z.output<typeof ListSuppressionsQueryDto.schema>;

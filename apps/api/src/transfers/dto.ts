import { RECORD_OBJECTS, TRANSFER_STATUSES, TRANSFER_TEXT_MAX } from '@bylinecrm/shared';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const text = z.string().trim().min(1).max(TRANSFER_TEXT_MAX);

/** Offer, or (with `record:transfer`) move, a record to another member. */
export class ProposeTransferDto extends createZodDto(
    z.object({
        object: z.enum(RECORD_OBJECTS),
        recordId: z.uuid(),
        toMemberId: z.uuid(),
        reason: text.optional(),
    }),
) {}

/** What a receiver says when declining, or anyone when cancelling. */
export class DecideTransferDto extends createZodDto(z.object({ note: text.optional() })) {}

/** Transfers by record (a record's history), by status (the inbox), or every one the caller may see. */
export class ListTransfersQueryDto extends createZodDto(
    z.object({
        object: z.enum(RECORD_OBJECTS).optional(),
        recordId: z.uuid().optional(),
        status: z.enum(TRANSFER_STATUSES).optional(),
    }),
) {}

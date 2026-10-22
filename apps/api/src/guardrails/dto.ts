import {
    GUARDRAIL_KINDS,
    GUARDRAIL_OUTCOMES,
    GUARDRAIL_REASON_MAX,
    GUARDRAIL_SHARED_MAILBOXES_MAX,
    LIST_LIMIT_DEFAULT,
    LIST_LIMIT_MAX,
} from '@bylinecrm/shared';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * `GET /guardrails/events` — newest first. `kind`, `outcome` and `actorMemberId` narrow it; `reviewed`
 * keeps only those marked legitimate (`true`) or only those not yet (`false`).
 */
export class ListGuardrailEventsQueryDto extends createZodDto(
    z.object({
        kind: z.enum(GUARDRAIL_KINDS).optional(),
        outcome: z.enum(GUARDRAIL_OUTCOMES).optional(),
        actorMemberId: z.uuid().optional(),
        reviewed: z.enum(['true', 'false']).optional(),
        cursor: z.string().min(1).optional(),
        limit: z.coerce.number().int().min(1).max(LIST_LIMIT_MAX).default(LIST_LIMIT_DEFAULT),
    }),
) {}
export type ListGuardrailEventsQuery = z.output<(typeof ListGuardrailEventsQueryDto)['schema']>;

/** Marks an event legitimate — the reviewer says why; it is stored with who and when. */
export class MarkLegitimateDto extends createZodDto(
    z.object({ reason: z.string().trim().min(1).max(GUARDRAIL_REASON_MAX) }),
) {}

/** Settings → Guardrails (GUARD-2), admins only. */
export const guardrailSettingsShape = z.object({
    poachEmailAtOnce: z.boolean().meta({
        description:
            'A `high` poaching alert is also emailed to the lead’s owner and the reviewers at once. The bell and the daily digest always tell. Off by default.',
    }),
    sharedMailboxMemberIds: z.array(z.uuid()).max(GUARDRAIL_SHARED_MAILBOXES_MAX).meta({
        description:
            'Members that are shared mailboxes (an outreach@ many people send from). Leads they own are treated as nobody’s by the recipient guard and the poaching detector — any member may mail them, with no block and no alert. Ownership is not changed. Each must be a member of the workspace.',
    }),
});
export class GuardrailSettingsDto extends createZodDto(guardrailSettingsShape) {}

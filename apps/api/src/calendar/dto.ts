import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { MEETINGS_LIMIT_DEFAULT, MEETINGS_LIMIT_MAX } from './calendar.constants';

const instant = z.iso.datetime({ offset: true });

/** `GET /meetings` — meetings, newest first, in a period, for one member or (admins) everyone. */
export class ListMeetingsQueryDto extends createZodDto(
    z.object({
        memberId: z
            .uuid()
            .optional()
            .meta({ description: 'One member’s meetings. Anyone but an admin sees only their own.' }),
        from: instant.optional().meta({ description: 'Meetings starting at or after this.' }),
        to: instant.optional().meta({ description: 'Meetings starting before this.' }),
        cursor: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(MEETINGS_LIMIT_MAX).default(MEETINGS_LIMIT_DEFAULT),
    }),
) {}

/** `GET /meetings/kpis?from=&to=` — each member's meeting KPIs over one period. */
export class MeetingKpisQueryDto extends createZodDto(
    z.object({
        from: instant.meta({ description: 'The period’s start (inclusive).' }),
        to: instant.meta({ description: 'The period’s end (exclusive).' }),
    }),
) {}

/** `GET /meetings/lead-suggestions` — the suggestions waiting for a member (an admin: any, or every member's). */
export class ListLeadSuggestionsQueryDto extends createZodDto(
    z.object({
        memberId: z.uuid().optional().meta({ description: 'One member’s. Anyone but an admin sees only their own.' }),
    }),
) {}

/** Add a suggested lead, or dismiss it: by address, for the caller (or, an admin, the member named). */
export class LeadSuggestionDecisionDto extends createZodDto(
    z.object({
        address: z.email().max(254),
        memberId: z.uuid().optional(),
    }),
) {}

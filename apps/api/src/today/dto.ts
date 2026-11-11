import { TODAY_LIMIT_DEFAULT, TODAY_LIMIT_MAX } from '@bylinecrm/shared';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** An IANA time zone the runtime knows (`Europe/London`); Postgres reads the same names. */
const timeZone = z
    .string()
    .max(64)
    .refine(
        (value) => {
            try {
                new Intl.DateTimeFormat('en', { timeZone: value });
                return true;
            } catch {
                return false;
            }
        },
        { message: 'not a time zone' },
    );

const common = {
    memberId: z
        .uuid()
        .optional()
        .meta({ description: 'Whose day: an admin may name any member; anyone else reads only their own.' }),
    timeZone: timeZone
        .default('UTC')
        .meta({ description: 'Where “today” is (IANA name): what is due today ends at its midnight.' }),
    limit: z.coerce.number().int().min(1).max(TODAY_LIMIT_MAX).default(TODAY_LIMIT_DEFAULT),
};

/** `GET /today` — every section's count and first page. */
export class TodayQueryDto extends createZodDto(z.object(common)) {}

/** `GET /today/<section>` — one section's next page. */
export class TodaySectionQueryDto extends createZodDto(
    z.object({ ...common, cursor: z.string().max(200).optional() }),
) {}

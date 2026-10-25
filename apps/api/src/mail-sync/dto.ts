import { BLOCKLIST_SCOPES, BLOCKLIST_VALUE_MAX } from '@bylinecrm/shared';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import {
    INTEGRATION_SENDERS_MAX,
    MAIL_THREADS_LIMIT_DEFAULT,
    MAIL_THREADS_LIMIT_MAX,
    SERVICE_MAIL_LIMIT_DEFAULT,
    SERVICE_MAIL_LIMIT_MAX,
} from './mail-sync.constants';

/** `GET /mail/threads?target=person:<id>` — the threads concerning one record. */
export class ListThreadsQueryDto extends createZodDto(
    z.object({
        target: z.string().meta({ description: '`person:<uuid>`, `company:<uuid>` or `opportunity:<uuid>`.' }),
        cursor: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(MAIL_THREADS_LIMIT_MAX).default(MAIL_THREADS_LIMIT_DEFAULT),
    }),
) {}

/** A blocklist entry to add: an address or `@domain`, for the caller alone or (admins) the workspace. */
export class CreateBlocklistEntryDto extends createZodDto(
    z.object({
        value: z.string().max(BLOCKLIST_VALUE_MAX),
        scope: z.enum(BLOCKLIST_SCOPES).default('personal'),
    }),
) {}

/** Comma-separated addresses, lower-cased and de-duplicated: `a@x.com,b@y.com`. */
const addressList = z
    .string()
    .transform((v) => [
        ...new Set(
            v
                .split(',')
                .map((a) => a.trim().toLowerCase())
                .filter(Boolean),
        ),
    ])
    .pipe(z.array(z.email()).min(1).max(INTEGRATION_SENDERS_MAX));

/** `GET /integrations/mail/service-messages` (SVC-1): what service inboxes hold, stored in `[since, until)`. */
export class ServiceMailQueryDto extends createZodDto(
    z.object({
        from: addressList.optional().meta({ description: 'Only mail from these senders (comma-separated).' }),
        since: z.iso.datetime({ offset: true }).meta({ description: 'Stored at or after this instant (ISO 8601).' }),
        until: z.iso
            .datetime({ offset: true })
            .optional()
            .meta({ description: 'Stored before this instant (ISO 8601).' }),
        cursor: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(SERVICE_MAIL_LIMIT_MAX).default(SERVICE_MAIL_LIMIT_DEFAULT),
    }),
) {}

/** The longest range one sent-counts question may span (PNW-926): a month's KPIs and their margin. */
export const SENT_COUNTS_RANGE_DAYS_MAX = 62;

/**
 * `GET /integrations/mail/sent-counts` (SVC-1): how much each sender sent on one UTC day — or, with `through`, over the
 * days `day`…`through` inclusive, where a distinct person is counted once across the range (PNW-926).
 */
export class SentCountsQueryDto extends createZodDto(
    z
        .object({
            from: addressList.meta({ description: 'The senders to count (comma-separated).' }),
            day: z.iso.date().meta({ description: 'A UTC day, `YYYY-MM-DD` — the first of the range.' }),
            through: z.iso
                .date()
                .optional()
                .meta({ description: 'The last UTC day of the range, inclusive (default: `day`). At most 62 days.' }),
        })
        .refine((q) => !q.through || q.through >= q.day, {
            message: '`through` is on or after `day`',
            path: ['through'],
        })
        .refine(
            (q) =>
                !q.through ||
                (Date.parse(q.through) - Date.parse(q.day)) / 86_400_000 + 1 <= SENT_COUNTS_RANGE_DAYS_MAX,
            { message: `a range spans at most ${SENT_COUNTS_RANGE_DAYS_MAX} days`, path: ['through'] },
        ),
) {}

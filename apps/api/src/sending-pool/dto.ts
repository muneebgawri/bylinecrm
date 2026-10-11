import { SENDING_POOL_LIMITS } from '@bylinecrm/shared';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { MAILBOX_RESUME_NOTE_MAX } from './sending-pool.constants';

const int = (min: number, max: number) => z.number().int().min(min).max(max);
const L = SENDING_POOL_LIMITS;

/** `PUT /sending-pool/settings` — every setting, validated against the same bounds the database checks. */
export class UpdateSendingPoolSettingsDto extends createZodDto(
    z
        .object({
            dailyCap: int(L.dailyCap.min, L.dailyCap.max),
            warmupStartPerDay: int(1, L.dailyCap.max),
            warmupDays: int(L.warmupDays.min, L.warmupDays.max),
            jitterMinSeconds: int(L.jitterSeconds.min, L.jitterSeconds.max),
            jitterMaxSeconds: int(L.jitterSeconds.min, L.jitterSeconds.max),
            bouncePauseBps: int(L.rateBps.min, L.rateBps.max),
            complaintPauseBps: int(L.rateBps.min, L.rateBps.max),
            rateMinSample: int(L.rateMinSample.min, L.rateMinSample.max),
            rateWindowDays: int(L.rateWindowDays.min, L.rateWindowDays.max),
        })
        .superRefine((v, ctx) => {
            if (v.warmupStartPerDay > v.dailyCap) {
                ctx.addIssue({ code: 'custom', path: ['warmupStartPerDay'], message: 'at most the daily cap' });
            }
            if (v.jitterMaxSeconds < v.jitterMinSeconds) {
                ctx.addIssue({ code: 'custom', path: ['jitterMaxSeconds'], message: 'at least the minimum' });
            }
        }),
) {}

/** `PUT /mailboxes/:id/pool` — a pool mailbox's own daily cap, or null to take the workspace's. */
export class SetMailboxPoolDto extends createZodDto(
    z.object({ dailyCap: int(L.dailyCap.min, L.dailyCap.max).nullable() }),
) {}

/** `POST /mailboxes/:id/resume` — resuming says why. */
export class ResumeMailboxDto extends createZodDto(
    z.object({
        note: z.string().trim().min(1, 'say why the mailbox is resumed').max(MAILBOX_RESUME_NOTE_MAX),
    }),
) {}

/** `PUT /sending-domains/:id` — the DKIM selector to check (`<selector>._domainkey.<domain>`). */
export class UpdateSendingDomainDto extends createZodDto(
    z.object({
        dkimSelector: z
            .string()
            .trim()
            .toLowerCase()
            .regex(/^[a-z0-9](?:[a-z0-9_-]{0,62})(?:\.[a-z0-9](?:[a-z0-9_-]{0,62}))*$/, 'a DNS label, e.g. google'),
    }),
) {}

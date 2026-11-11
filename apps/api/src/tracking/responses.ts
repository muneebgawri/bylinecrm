import type { TrackingCounts, TrackingDomainView, TrackingSettingsView } from '@bylinecrm/shared';
import { z } from 'zod';
import { named } from '../openapi/responses';

/** Tracking (P3-4, FR-CRMS-8), as the API returns it. */

const isoTime = z.iso.datetime();

export const trackingDomainView = named(
    'TrackingDomain',
    z.object({
        domain: z
            .string()
            .meta({ description: 'Lower case: the host tracked links and the open pixel are served from.' }),
        status: z.enum(['unchecked', 'pass', 'fail']).meta({
            description:
                'Links in outreach mail are rewritten to short links only while `pass`; until then they go out untracked.',
        }),
        lastCheck: z.object({ outcome: z.enum(['pass', 'fail']), message: z.string() }).nullable(),
        checkedAt: isoTime.nullable(),
        updatedAt: isoTime,
    }),
);

/** `GET /tracking/domain` and every change to it: the record to publish, and the domain while one is set. */
export const trackingSettingsView = named(
    'TrackingSettings',
    z.object({
        cnameTarget: z.string().meta({
            description: 'The host the domain’s CNAME must point at (the API); known before any domain is set.',
        }),
        domain: trackingDomainView
            .nullable()
            .meta({ description: '`null` while none is set: links go out untracked.' }),
    }),
);

/** On a send and on a sequence step: `opens` is indicative (clients prefetch images) and never drives anything. */
export const trackingCounts = named(
    'TrackingCounts',
    z.object({
        clicks: z.number().int(),
        uniqueClicks: z.number().int().meta({ description: 'Distinct links clicked at least once.' }),
        opens: z
            .number()
            .int()
            .meta({ description: 'Indicative: a mail client’s image prefetch counts the same as a read.' }),
    }),
);

type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;
export type TrackingTypeChecks = [
    Assert<Same<z.output<typeof trackingDomainView>, TrackingDomainView>>,
    Assert<Same<z.output<typeof trackingSettingsView>, TrackingSettingsView>>,
    Assert<Same<z.output<typeof trackingCounts>, TrackingCounts>>,
];

/** TRACK-2: `GET /tracking/policy` and every change to it. */
export const trackingPolicyView = named(
    'TrackingPolicy',
    z.object({
        provider: z.enum(['builtin', 'smtp2go']).meta({
            description:
                '`builtin`: our short links and pixel (the short-link domain must pass). `smtp2go`: CRM-written mail goes through SMTP2Go, which tracks it, with a copy kept in Gmail’s Sent.',
        }),
        trackOpens: z.boolean(),
        trackClicks: z.boolean(),
        trackPersonalMail: z
            .boolean()
            .meta({ description: 'Whether an email written in the CRM is tracked unless its writer turns it off.' }),
        gmailReplyNotices: z.boolean().meta({
            description: 'Whether a member hears of a CRM contact’s reply to an email they sent straight from Gmail.',
        }),
        smtp2go: z.object({
            keySet: z.boolean().meta({ description: 'An API key is set; it is never shown.' }),
            hookUrl: z.string(),
            hookAuthorization: z.string().nullable(),
            lastHookAt: isoTime.nullable(),
            lastHookResult: z.string().nullable(),
        }),
        mailboxesWithoutCopy: z.array(z.object({ id: z.uuid(), email: z.string() })).meta({
            description:
                'Personal mailboxes connected without `gmail.insert`: their CRM-written mail goes through Gmail until they connect again.',
        }),
    }),
);

import { SMTP2GO_HOOK_RESULTS } from '@bylinecrm/shared';
import { z } from 'zod';
import { mailboxView } from '../mail-accounts/responses';
import { dateTime, named } from '../openapi/responses';

/** An SMTP2Go pool mailbox (TRANS-1), as its admin sees it: never the API key. */
export const smtp2goMailboxView = named(
    'Smtp2GoMailbox',
    z.object({
        mailbox: mailboxView,
        hookUrl: z.url().meta({ description: "SMTP2Go's webhook URL for this mailbox (Settings > Webhooks)." }),
        hookAuthorization: z.string().nullable().meta({
            description:
                'The Authorization header SMTP2Go must send with it (`Bearer …`); null once the mailbox is disconnected.',
        }),
        lastHookAt: dateTime.nullable(),
        lastHookResult: z.enum(SMTP2GO_HOOK_RESULTS).nullable(),
    }),
);

export const smtp2goHookResult = named('Smtp2GoHookResult', z.object({ result: z.enum(SMTP2GO_HOOK_RESULTS) }));

/** What "Send test" did (TRANS-1): one message to the admin asking, through the mailbox's SMTP2Go key. */
export const smtp2goTestResult = named(
    'Smtp2GoTestResult',
    z.object({
        outcome: z.enum(['sent', 'refused']).meta({
            description:
                '`sent`: SMTP2Go took it — its webhook events for it follow; `refused`: the suppression list or SMTP2Go refused it (`error`).',
        }),
        to: z.string().meta({ description: 'The admin’s own account address it went to.' }),
        outboundId: z.uuid().nullable().meta({
            description: 'The test send; null when the suppression list refused it before anything was made.',
        }),
        error: z.object({ code: z.string(), message: z.string() }).nullable(),
    }),
);

export type Smtp2GoTestResult = z.output<typeof smtp2goTestResult>;
export type Smtp2GoMailboxView = z.output<typeof smtp2goMailboxView>;
export type Smtp2GoHookResultView = z.output<typeof smtp2goHookResult>;

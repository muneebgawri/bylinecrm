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

export type Smtp2GoMailboxView = z.output<typeof smtp2goMailboxView>;
export type Smtp2GoHookResultView = z.output<typeof smtp2goHookResult>;

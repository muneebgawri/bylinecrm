import {
    GUARDRAIL_KINDS,
    GUARDRAIL_OUTCOMES,
    GUARDRAIL_PATHS,
    GUARDRAIL_SEVERITIES,
    type GuardrailEventView,
} from '@bylinecrm/shared';
import { z } from 'zod';
import { id, named, page } from '../openapi/responses';

const dateTime = z.iso.datetime();

/** Guardrail events (GUARD-1, FR-CRMS-21), as the API returns them. */

const member = z.object({ memberId: id, name: z.string().nullable() });

export const guardrailEventView = named(
    'GuardrailEvent',
    z.object({
        id,
        kind: z.enum(GUARDRAIL_KINDS).meta({
            description:
                'Why: `suppressed`, `excluded_customer` / `excluded_account_managed` (outreach exclusions), `owned_by_other` (another member’s person or company), `in_negotiation` (an open deal another member owns), `cold_to_known` (a sequence for a warm contact), `repeat_blocks` (three blocks on owned addresses by one member in a day).',
        }),
        outcome: z.enum(GUARDRAIL_OUTCOMES).meta({
            description:
                '`blocked`: refused. `warned`: let through with a warning. `allowed`: an exempt sender (`record:transfer`) let through, kept for the audit.',
        }),
        severity: z.enum(GUARDRAIL_SEVERITIES),
        path: z.enum(GUARDRAIL_PATHS),
        actor: member.nullable().meta({ description: 'Who tried; null once their seat is gone.' }),
        owner: member.nullable().meta({ description: 'Whose lead it was, for `owned_by_other` / `in_negotiation`.' }),
        personId: id.nullable(),
        companyId: id.nullable(),
        address: z.string().nullable(),
        message: z.string().meta({ description: 'What the guard told the sender.' }),
        createdAt: dateTime,
        legitimate: z
            .object({ by: member.nullable(), reason: z.string(), at: dateTime })
            .nullable()
            .meta({ description: 'Set once a reviewer marked it legitimate.' }),
    }),
);

export const guardrailEventPage = named('GuardrailEventPage', page(guardrailEventView));

type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
export type GuardrailEventViewCheck =
    Same<z.output<typeof guardrailEventView>, GuardrailEventView> extends true ? true : never;

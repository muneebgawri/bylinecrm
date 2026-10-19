import { RECORD_OBJECTS, TRANSFER_STATUSES, type TransferView } from '@bylinecrm/shared';
import { z } from 'zod';
import { id, named } from '../openapi/responses';

const dateTime = z.iso.datetime();

const transferMember = named('TransferMember', z.object({ memberId: id, name: z.string().nullable() }));

const labelledTarget = z.object({ type: z.enum(RECORD_OBJECTS), id, label: z.string() });

/** An ownership transfer (OWN-1), as the API returns it. */
export const transferView = named(
    'Transfer',
    z.object({
        id,
        object: z.enum(RECORD_OBJECTS),
        recordId: id,
        recordLabel: z.string().meta({ description: 'The record’s name as it reads now.' }),
        from: transferMember.nullable().meta({ description: 'The owner before; null when the record had none.' }),
        to: transferMember,
        proposedBy: transferMember,
        decidedBy: transferMember.nullable(),
        status: z.enum(TRANSFER_STATUSES).meta({
            description:
                '`proposed`: waiting on the receiver. `accepted` / `forced`: the record (and its unit) changed owner. `declined` / `cancelled`: nothing moved.',
        }),
        reason: z.string().nullable(),
        note: z.string().nullable(),
        moved: z.array(labelledTarget).meta({ description: 'Every record that moved; empty until it completes.' }),
        createdAt: dateTime,
        decidedAt: dateTime.nullable(),
    }),
);

type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
export type TransferViewCheck = Same<z.output<typeof transferView>, TransferView> extends true ? true : never;

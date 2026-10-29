import { normaliseEmail } from '@bylinecrm/shared';
import type { SuppressionService } from '../suppression/suppression.service';
import type { BiginRecord } from './bigin.port';

/** The note an opt-out carried over from Bigin keeps on its suppression. */
export const BIGIN_OPT_OUT_NOTE = 'Opted out of email in Bigin';

/**
 * BIGIN-1: a Bigin Contact with `Email_Opt_Out` set asked not to be emailed. Its address goes on the suppression list
 * as the person's own unsubscribe (`unsubscribe`, `recipient`) — the one write every send path checks, which the CRM
 * never lifts. Idempotent (an address already suppressed keeps its entry), and one way: a Contact whose flag Bigin
 * later clears is not taken off the list — a member lifts it, with a reason, if the person asks again.
 *
 * Returns how many of the records' addresses were opted out (whether newly suppressed or already).
 */
export async function suppressBiginOptOuts(
    suppression: Pick<SuppressionService, 'suppress'>,
    workspaceId: string,
    records: readonly BiginRecord[],
): Promise<number> {
    const addresses = new Set<string>();
    for (const record of records) {
        if (record.Email_Opt_Out !== true) continue;
        for (const field of ['Email', 'Secondary_Email'] as const) {
            const value = record[field];
            const address = typeof value === 'string' ? normaliseEmail(value) : null;
            if (address) addresses.add(address);
        }
    }
    for (const address of addresses) {
        await suppression.suppress(workspaceId, {
            address,
            reason: 'unsubscribe',
            source: 'recipient',
            note: BIGIN_OPT_OUT_NOTE,
        });
    }
    return addresses.size;
}

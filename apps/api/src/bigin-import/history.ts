import {
    plainBiginId,
    type BiginHistoryPhase,
    type BiginImportObject,
    type ExternalEmailEntry,
} from '@bylinecrm/shared';
import { emailOf, isObject, num, text } from '../twenty-import/twenty-records';
import type { BiginRecord } from './bigin.port';
import { biginInstant } from './cursor-policy';
import { lookupId } from './mappers';

/**
 * What a Bigin export's history rows say (BIGIN-1), read the way the mappers read a record: pure, and a row that
 * cannot be placed says why (`skip`). The runner resolves the Bigin ids through the links and writes the entries.
 */

/** The key an imported entry is the one entry of, under `BIGIN_TIMELINE_SOURCE`, by phase. */
export const HISTORY_KEY_PREFIX: Readonly<Record<BiginHistoryPhase, string>> = {
    StageHistory: 'stage-history:',
    Emails: 'email:',
};

export interface StageHistoryRow {
    externalId: string;
    /** The deal's Bigin id. */
    dealId: string;
    /** The stage the deal left; null for the stage it started in. */
    from: string | null;
    to: string;
    at: Date;
}

/** One stage history row: the deal entered `Stage` at `Modified_Time`, from the stage of its row before. */
export function readStageHistory(record: BiginRecord): StageHistoryRow | { skip: string } {
    const externalId = plainBiginId(record.id);
    const dealId = lookupId(record.Deal);
    const to = text(record.Stage);
    const at = biginInstant(record.Modified_Time);
    if (!externalId || !dealId) return { skip: 'no deal' };
    if (!to || !at) return { skip: 'no stage or time' };
    const from = text(record.Previous_Stage);
    // Bigin also writes a row when only a deal's amount or closing date changed: no move.
    if (from !== null && from.toLowerCase() === to.toLowerCase()) return { skip: 'not a stage change' };
    return { externalId, dealId, from, to, at };
}

/** An email log's `Module`, as the module its record is linked under. */
const EMAIL_MODULE: Readonly<Record<string, BiginImportObject>> = {
    Contacts: 'Contacts',
    Accounts: 'Accounts',
    Deals: 'Deals',
    Potentials: 'Deals',
    Pipelines: 'Deals',
};

/** A logged email's text field, cut to what an entry shows. */
const FIELD_MAX = 1_000;

function field(value: unknown): string | null {
    const s = text(value);
    return s && s.length > FIELD_MAX ? `${s.slice(0, FIELD_MAX - 1)}…` : s;
}

const ADDRESS = /[^\s<>,;"']+@[^\s<>,;"']+/g;

export interface EmailRow {
    externalId: string;
    /** The record Bigin logged it on, by module; null when the module is not one the importer reads. */
    record: { object: BiginImportObject; id: string } | null;
    /** The recipients' addresses, lower-cased: a person here with one of them has it on their timeline too. */
    recipients: string[];
    /** The sender's Bigin user address, lower-cased: the member who sent it, when they are one here. */
    sentBy: string | null;
    at: Date;
    entry: Omit<ExternalEmailEntry, 'sentByMemberId'>;
}

/** One email log: sent at `Sent_On` (else when it was logged), on `Record` in `Module` — never a body, which it has not. */
export function readEmail(record: BiginRecord): EmailRow | { skip: string } {
    const externalId = plainBiginId(record.id);
    const at = biginInstant(record.Sent_On) ?? biginInstant(record.Created_Time);
    if (!externalId || !at) return { skip: 'no time' };
    const module = text(record.Module);
    const recordId = lookupId(record.Record);
    const object = module ? EMAIL_MODULE[module] : undefined;
    const to = field(record.Sent_To);
    return {
        externalId,
        record: object && recordId ? { object, id: recordId } : null,
        recipients: [...new Set((to?.match(ADDRESS) ?? []).map((a) => emailOf(a)).filter((a): a is string => !!a))],
        sentBy: isObject(record.Sent_By) ? emailOf(record.Sent_By.email) : null,
        at,
        entry: {
            subject: field(record.Subject),
            from: field(record.Sender),
            to,
            cc: field(record.Cc),
            status: field(record.Status),
            opens: num(record.No_of_Opens),
            clicks: num(record.No_of_Clicks),
        },
    };
}

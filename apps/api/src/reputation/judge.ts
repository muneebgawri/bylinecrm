import { hamming } from './fingerprint';

/** One message that started a thread from a mailbox in the window: who it went to and what it looked like. */
export interface WindowEntry {
    /** Lower case; the message's to, cc and bcc. */
    addresses: readonly string[];
    simhash: bigint | null;
    subjectKey: string | null;
    at: Date;
}

/** Distinct recipients of the entries at or after `since`. */
export function recipientsSince(entries: readonly WindowEntry[], since: Date): Set<string> {
    const out = new Set<string>();
    for (const e of entries) if (e.at >= since) for (const a of e.addresses) out.add(a);
    return out;
}

/** Distinct recipients of the entries whose body is within `distance` bits of `simhash`. */
export function nearDuplicateRecipients(
    entries: readonly WindowEntry[],
    simhash: bigint | null,
    distance: number,
): Set<string> {
    const out = new Set<string>();
    if (simhash === null) return out;
    for (const e of entries) {
        if (e.simhash === null || hamming(e.simhash, simhash) > distance) continue;
        for (const a of e.addresses) out.add(a);
    }
    return out;
}

/** Distinct recipients of the entries with this normalised subject (an empty subject never repeats). */
export function subjectRecipients(entries: readonly WindowEntry[], subjectKey: string | null): Set<string> {
    const out = new Set<string>();
    if (!subjectKey) return out;
    for (const e of entries) if (e.subjectKey === subjectKey) for (const a of e.addresses) out.add(a);
    return out;
}

/** The biggest near-identical group in the window: how many distinct recipients its body reached. */
export function largestNearDuplicate(
    entries: readonly WindowEntry[],
    distance: number,
): { recipients: number; simhash: bigint | null } {
    let best = { recipients: 0, simhash: null as bigint | null };
    for (const e of entries) {
        const n = nearDuplicateRecipients(entries, e.simhash, distance).size;
        if (n > best.recipients) best = { recipients: n, simhash: e.simhash };
    }
    return best;
}

/** The subject that reached the most distinct recipients in the window. */
export function largestSubject(entries: readonly WindowEntry[]): { recipients: number; subjectKey: string | null } {
    let best = { recipients: 0, subjectKey: null as string | null };
    const seen = new Set<string>();
    for (const e of entries) {
        if (!e.subjectKey || seen.has(e.subjectKey)) continue;
        seen.add(e.subjectKey);
        const n = subjectRecipients(entries, e.subjectKey).size;
        if (n > best.recipients) best = { recipients: n, subjectKey: e.subjectKey };
    }
    return best;
}

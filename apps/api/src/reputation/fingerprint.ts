/**
 * What REP-1 compares messages by: a 64-bit simhash of the normalised body and the normalised subject.
 * Pure; the same for a message built in the CRM and one read back from Gmail sync.
 */

export interface Fingerprint {
    /** Signed 64-bit (Postgres `bigint`); null when the body has nothing left to compare once normalised. */
    simhash: bigint | null;
    subjectKey: string;
}

const GREETING = /^(?:hi|hello|hey|dear|hiya|greetings|good (?:morning|afternoon|evening))\b/i;
const SIGN_OFF =
    /^(?:best|thanks|thank you|many thanks|regards|kind regards|best regards|warm regards|cheers|sincerely|all the best|talk soon)\b[\s,.!]*$/i;
const QUOTE_HEADER = /^on .+wrote:\s*$/i;
const FORWARD_HEADER = /^-{2,}\s*(?:original message|forwarded message)/i;

/**
 * The text a message is compared by: the quoted part (`>` lines, from "On … wrote:" or a forwarded
 * header on), the signature (from `-- ` or a sign-off line on) and the greeting line are dropped; URLs,
 * addresses and numbers removed; lower case, letters only, single spaces. Two messages that differ only
 * in who they greet, a link's tracking id or a date normalise alike.
 */
export function normaliseBody(text: string): string {
    const kept: string[] = [];
    let first = true;
    for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
        const line = raw.trim();
        if (line === '--' || raw.startsWith('-- ') || QUOTE_HEADER.test(line) || FORWARD_HEADER.test(line)) break;
        if (SIGN_OFF.test(line)) break;
        if (line.startsWith('>')) continue;
        if (line === '') continue;
        if (first) {
            first = false;
            if (GREETING.test(line)) continue;
        }
        kept.push(line);
    }
    return kept
        .join(' ')
        .replace(/https?:\/\/\S+|www\.\S+/gi, ' ')
        .replace(/\S+@\S+/g, ' ')
        .replace(/\d+/g, ' ')
        .toLowerCase()
        .replace(/[^\p{L}]+/gu, ' ')
        .trim();
}

/** A subject without `Re:` / `Fwd:` prefixes, numbers or case: "Re: Q3 pricing #42" → "q pricing". */
export function normaliseSubject(subject: string): string {
    let s = subject.trim();
    for (;;) {
        const next = s.replace(/^(?:re|fw|fwd|aw|sv)\s*(?:\[\d+\])?\s*:\s*/i, '');
        if (next === s) break;
        s = next;
    }
    return s
        .replace(/\d+/g, ' ')
        .toLowerCase()
        .replace(/[^\p{L}]+/gu, ' ')
        .trim()
        .slice(0, 300);
}

const MASK = (1n << 64n) - 1n;
const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;

/** FNV-1a, 64 bits, over a string's UTF-16 code units. */
function fnv1a64(s: string): bigint {
    let h = FNV_OFFSET;
    for (let i = 0; i < s.length; i++) {
        h ^= BigInt(s.charCodeAt(i));
        h = (h * FNV_PRIME) & MASK;
    }
    return h;
}

/**
 * Charikar's simhash over the normalised text's word shingles (single words and adjacent pairs, so order
 * counts a little): near-identical texts land a few bits apart. Signed, to fit Postgres `bigint`. Null for
 * an empty text (nothing to compare — never a match).
 */
export function simhash(normalised: string): bigint | null {
    const words = normalised.split(' ').filter((w) => w.length > 0);
    if (words.length === 0) return null;
    const features = new Map<string, number>();
    const add = (f: string) => features.set(f, (features.get(f) ?? 0) + 1);
    for (let i = 0; i < words.length; i++) {
        add(words[i]!);
        if (i + 1 < words.length) add(`${words[i]} ${words[i + 1]}`);
    }
    const v = new Array<number>(64).fill(0);
    for (const [feature, weight] of features) {
        const h = fnv1a64(feature);
        for (let bit = 0; bit < 64; bit++) v[bit]! += (h >> BigInt(bit)) & 1n ? weight : -weight;
    }
    let out = 0n;
    for (let bit = 0; bit < 64; bit++) if (v[bit]! > 0) out |= 1n << BigInt(bit);
    return BigInt.asIntN(64, out);
}

/** Bits that differ between two simhashes (signed or not). */
export function hamming(a: bigint, b: bigint): number {
    let x = BigInt.asUintN(64, a ^ b);
    let n = 0;
    while (x) {
        x &= x - 1n;
        n++;
    }
    return n;
}

export function fingerprint(subject: string, text: string): Fingerprint {
    return { simhash: simhash(normaliseBody(text)), subjectKey: normaliseSubject(subject) };
}

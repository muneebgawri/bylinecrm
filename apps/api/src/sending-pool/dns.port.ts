/** Injection token for the DNS adapter; tests override it with an in-memory fake. */
export const DNS_PORT = Symbol('DNS_PORT');

/**
 * The only DNS the sending pool needs (FR-CRMS-13): a name's TXT records, each record's chunks
 * joined. A name with no records (NXDOMAIN or no TXT data) answers `[]`; a lookup that fails for any
 * other reason — a timeout, a SERVFAIL — throws `DnsLookupFailed`, so "could not check" is never read
 * as "has no record". Never called inside a database transaction (P2-2a).
 */
export interface DnsPort {
    resolveTxt(name: string): Promise<string[]>;
}

export class DnsLookupFailed extends Error {
    constructor(
        readonly lookedUp: string,
        readonly reason: string,
    ) {
        super(`DNS lookup for ${lookedUp} failed: ${reason}`);
    }
}

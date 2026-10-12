/** Injection token for the DNS adapter; tests override it with an in-memory fake. */
export const DNS_PORT = Symbol('DNS_PORT');

/**
 * A domain's MX lookup, as the verifier reads it (P3-5): the exchanges by priority, or why there
 * are none — the name does not exist at all (NXDOMAIN) or exists with no MX records (NODATA). The
 * two are kept apart because they mean different things about an address: no such domain is
 * certain; a domain with no mail server is a domain with no mail server.
 */
export type MxLookup = { status: 'found'; exchanges: string[] } | { status: 'no_domain' } | { status: 'no_records' };

/**
 * The only DNS the application does: a name's TXT records for the sending pool's domain checks
 * (FR-CRMS-13), and a domain's MX records for address verification (FR-CRMS-14). A TXT name with no
 * records (NXDOMAIN or no TXT data) answers `[]`; a lookup that fails for any other reason — a
 * timeout, a SERVFAIL — throws `DnsLookupFailed`, so "could not check" is never read as "has no
 * record". Never called inside a database transaction (P2-2a).
 */
export interface DnsPort {
    resolveTxt(name: string): Promise<string[]>;
    resolveMx(name: string): Promise<MxLookup>;
}

export class DnsLookupFailed extends Error {
    constructor(
        readonly lookedUp: string,
        readonly reason: string,
    ) {
        super(`DNS lookup for ${lookedUp} failed: ${reason}`);
    }
}

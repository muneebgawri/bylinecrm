import { DnsLookupFailed, type DnsPort, type MxLookup } from '../../src/sending-pool/dns.port';
import { assertNoOpenTransaction } from '../../src/infra/transaction-scope';

/**
 * In-memory DNS for the tests: TXT records by name, MX records by domain and CNAMEs by name (P3-4),
 * never the network. A
 * TXT name with no records answers as a real resolver does for NXDOMAIN / NODATA — no records. A
 * domain nothing was set for does not exist (`no_domain`); one set with no exchanges exists but has
 * no mail server (`no_records`); `failMx` makes its lookups fail, as a timeout would. Like the real
 * adapter, it refuses to be asked inside a database transaction (P2-2a).
 */
export class FakeDns implements DnsPort {
    private readonly txt = new Map<string, string[]>();
    private readonly mx = new Map<string, string[]>();
    private readonly cname = new Map<string, string>();
    private readonly failing = new Set<string>();
    readonly lookups: string[] = [];
    readonly mxLookups: string[] = [];
    readonly cnameLookups: string[] = [];

    set(name: string, ...records: string[]): void {
        this.txt.set(name.toLowerCase(), records);
    }

    /** The domain's mail exchanges by priority; none means the domain exists without a mail server. */
    setMx(domain: string, ...exchanges: string[]): void {
        const name = domain.toLowerCase();
        this.mx.set(name, exchanges);
        this.failing.delete(name);
    }

    /** The name is a CNAME to the target (P3-4); `null` removes it. */
    setCname(name: string, target: string | null): void {
        if (target === null) this.cname.delete(name.toLowerCase());
        else this.cname.set(name.toLowerCase(), target.toLowerCase());
    }

    /** The domain is gone: NXDOMAIN for its MX. */
    noDomain(domain: string): void {
        this.mx.delete(domain.toLowerCase());
    }

    /** Every MX lookup of the domain fails (a timeout, a SERVFAIL) until told otherwise. */
    failMx(domain: string, failing = true): void {
        const name = domain.toLowerCase();
        if (failing) this.failing.add(name);
        else this.failing.delete(name);
    }

    /** A domain that passes all three checks with Google Workspace's defaults. */
    allowGoogle(domain: string, selector = 'google'): void {
        this.set(domain, 'v=spf1 include:_spf.google.com ~all');
        this.set(`${selector}._domainkey.${domain}`, 'v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOC');
        this.set(`_dmarc.${domain}`, 'v=DMARC1; p=none; rua=mailto:dmarc@' + domain);
    }

    resolveTxt(name: string): Promise<string[]> {
        assertNoOpenTransaction('FakeDns.resolveTxt');
        this.lookups.push(name.toLowerCase());
        return Promise.resolve(this.txt.get(name.toLowerCase()) ?? []);
    }

    resolveCname(name: string): Promise<string | null> {
        assertNoOpenTransaction('FakeDns.resolveCname');
        this.cnameLookups.push(name.toLowerCase());
        return Promise.resolve(this.cname.get(name.toLowerCase()) ?? null);
    }

    resolveMx(name: string): Promise<MxLookup> {
        assertNoOpenTransaction('FakeDns.resolveMx');
        const domain = name.toLowerCase();
        this.mxLookups.push(domain);
        if (this.failing.has(domain)) return Promise.reject(new DnsLookupFailed(domain, 'ETIMEOUT'));
        const exchanges = this.mx.get(domain);
        if (exchanges === undefined) return Promise.resolve({ status: 'no_domain' });
        if (exchanges.length === 0) return Promise.resolve({ status: 'no_records' });
        return Promise.resolve({ status: 'found', exchanges: [...exchanges] });
    }
}

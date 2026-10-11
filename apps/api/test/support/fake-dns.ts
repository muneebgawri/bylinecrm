import type { DnsPort } from '../../src/sending-pool/dns.port';
import { assertNoOpenTransaction } from '../../src/infra/transaction-scope';

/**
 * In-memory DNS for the tests: TXT records by name, nothing else, never the network. A name with no
 * records answers as a real resolver does for NXDOMAIN / NODATA — no records. Like the real adapter,
 * it refuses to be asked inside a database transaction (P2-2a).
 */
export class FakeDns implements DnsPort {
    private readonly txt = new Map<string, string[]>();
    readonly lookups: string[] = [];

    set(name: string, ...records: string[]): void {
        this.txt.set(name.toLowerCase(), records);
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
}

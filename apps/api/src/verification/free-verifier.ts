import { Inject, Injectable } from '@nestjs/common';
import { FREE_VERIFIER_SOURCE, type EmailVerification } from '@bylinecrm/shared';
import { DNS_PORT, DnsLookupFailed, type DnsPort, type MxLookup } from '../sending-pool/dns.port';
import { judgeAddress, parseAddress } from './address-checks';
import type { Verifier } from './verifier.port';

/**
 * The free verification layer (P3-5, FR-CRMS-14): syntax, the domain's MX records through the one
 * DNS port, the disposable-domain list and role-address detection. No SMTP probe — nothing connects
 * to the recipient's mail server. One lookup per address, none when the syntax already fails; a
 * lookup DNS cannot complete is `unknown`, never read as valid.
 */
@Injectable()
export class FreeVerifier implements Verifier {
    readonly source = FREE_VERIFIER_SOURCE;

    constructor(@Inject(DNS_PORT) private readonly dns: DnsPort) {}

    async verify(address: string): Promise<EmailVerification> {
        const parsed = parseAddress(address);
        let mx: MxLookup | 'failed' = 'failed';
        if (parsed) {
            try {
                mx = await this.dns.resolveMx(parsed.domain);
            } catch (error) {
                if (!(error instanceof DnsLookupFailed)) throw error;
            }
        }
        return { ...judgeAddress(address, mx), source: this.source };
    }
}

import { Inject, Injectable } from '@nestjs/common';
import type { EnrichmentFactKey, EnrichmentObject, MailProvider } from '@bylinecrm/shared';
import { DNS_PORT, DnsLookupFailed, type DnsPort } from '../sending-pool/dns.port';
import type { Enricher, EnrichmentFinding, EnrichmentSubject } from './enricher.port';

const FACTS: readonly EnrichmentFactKey[] = ['mail_provider'];

/** Which provider a mail exchange belongs to, by the host it is at. */
export function mailProviderOf(exchanges: readonly string[]): MailProvider {
    const hosts = exchanges.map((h) => h.toLowerCase().replace(/\.$/, ''));
    if (hosts.some((h) => /(^|\.)(google|googlemail)\.com$/.test(h))) return 'google';
    if (hosts.some((h) => /(^|\.)(outlook\.com|office365\.(com|us)|mail\.protection\.outlook\.com)$/.test(h))) {
        return 'microsoft';
    }
    return 'other';
}

/**
 * The company domain's mail records (P4-2): which provider handles its mail, through the one DNS
 * port (the sending pool's, P3-2). A domain with no mail server is no answer; a lookup DNS could not
 * complete is a failure, never "no provider".
 */
@Injectable()
export class DnsEnricher implements Enricher {
    readonly source = 'dns' as const;

    constructor(@Inject(DNS_PORT) private readonly dns: DnsPort) {}

    facts(object: EnrichmentObject): readonly EnrichmentFactKey[] {
        return object === 'company' ? FACTS : [];
    }

    applies(subject: EnrichmentSubject): boolean {
        return subject.object === 'company' && Boolean(subject.company?.domain);
    }

    async enrich(subject: EnrichmentSubject): Promise<EnrichmentFinding[]> {
        const domain = subject.company!.domain!;
        try {
            const mx = await this.dns.resolveMx(domain);
            if (mx.status !== 'found' || mx.exchanges.every((e) => e === '.' || e === '')) {
                return [{ field: 'mail_provider', status: 'no_answer', note: `${domain} has no mail server` }];
            }
            const note = mx.exchanges[0];
            return [
                {
                    field: 'mail_provider',
                    status: 'answered',
                    value: mailProviderOf(mx.exchanges),
                    rank: 1,
                    ...(note ? { note } : {}),
                },
            ];
        } catch (error) {
            if (error instanceof DnsLookupFailed)
                return [{ field: 'mail_provider', status: 'failed', note: error.message }];
            throw error;
        }
    }
}

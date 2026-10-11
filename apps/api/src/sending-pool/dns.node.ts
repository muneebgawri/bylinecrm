import { Injectable } from '@nestjs/common';
import { Resolver } from 'node:dns/promises';
import { assertNoOpenTransaction } from '../infra/transaction-scope';
import { DnsLookupFailed, type DnsPort } from './dns.port';
import { DNS_LOOKUP_TIMEOUT_MS } from './sending-pool.constants';

/** "No such name" and "no records of that type" both mean: there is no record. */
const NO_RECORDS = new Set(['ENOTFOUND', 'ENODATA']);

/** DNS through the system's resolver, with a per-lookup timeout. */
@Injectable()
export class NodeDns implements DnsPort {
    private readonly resolver = new Resolver({ timeout: DNS_LOOKUP_TIMEOUT_MS, tries: 2 });

    async resolveTxt(name: string): Promise<string[]> {
        assertNoOpenTransaction('NodeDns.resolveTxt');
        try {
            const records = await this.resolver.resolveTxt(name);
            return records.map((chunks) => chunks.join(''));
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code ?? '';
            if (NO_RECORDS.has(code)) return [];
            throw new DnsLookupFailed(name, code || (error instanceof Error ? error.message : String(error)));
        }
    }
}

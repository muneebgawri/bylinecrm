import { Injectable } from '@nestjs/common';
import { Resolver } from 'node:dns/promises';
import { assertNoOpenTransaction } from '../infra/transaction-scope';
import { DnsLookupFailed, type DnsPort, type MxLookup } from './dns.port';
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
            if (NO_RECORDS.has(codeOf(error))) return [];
            throw failed(name, error);
        }
    }

    async resolveMx(name: string): Promise<MxLookup> {
        assertNoOpenTransaction('NodeDns.resolveMx');
        try {
            const records = await this.resolver.resolveMx(name);
            return {
                status: 'found',
                exchanges: [...records].sort((a, b) => a.priority - b.priority).map((r) => r.exchange),
            };
        } catch (error) {
            const code = codeOf(error);
            if (code === 'ENOTFOUND') return { status: 'no_domain' };
            if (code === 'ENODATA') return { status: 'no_records' };
            throw failed(name, error);
        }
    }

    async resolveCname(name: string): Promise<string | null> {
        assertNoOpenTransaction('NodeDns.resolveCname');
        try {
            const records = await this.resolver.resolveCname(name);
            return records[0]?.toLowerCase() ?? null;
        } catch (error) {
            if (NO_RECORDS.has(codeOf(error))) return null;
            throw failed(name, error);
        }
    }
}

function codeOf(error: unknown): string {
    return (error as NodeJS.ErrnoException).code ?? '';
}

function failed(name: string, error: unknown): DnsLookupFailed {
    return new DnsLookupFailed(name, codeOf(error) || (error instanceof Error ? error.message : String(error)));
}

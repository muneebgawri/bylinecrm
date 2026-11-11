import { promises as dns } from 'node:dns';
import { BlockList, isIPv4, isIPv6 } from 'node:net';
import { Inject, Injectable, Logger, Optional, type OnModuleDestroy } from '@nestjs/common';
import { ENV, type Env } from '../config/env';

/** Where Google publishes the addresses its mail leaves from: the SPF record and the netblocks it includes. */
export const GOOGLE_SPF_DOMAIN = '_spf.google.com';
/** How often the list is read again; Google changes it rarely, and a stale list only refuses a new range. */
export const NETBLOCKS_REFRESH_MS = 60 * 60 * 1000;
/** How deep `include:` is followed; Google's record is two levels. */
const INCLUDE_DEPTH = 4;

export type ResolveTxt = (hostname: string) => Promise<string[][]>;
/** The TXT lookup; a test provides its own, the process uses the resolver's. */
export const RESOLVE_TXT = Symbol('RESOLVE_TXT');

/**
 * GUARD-4: who may connect to the relay. Google Workspace delivers the routed mail from its own addresses, so
 * only those (`_spf.google.com`, read at start and every hour) and RELAY_ALLOWED_CIDRS (a test from one
 * address) are accepted; everyone else is refused at connect. A lookup failure keeps the last list — the relay
 * never opens because DNS blinked — and the extra ranges apply from the start, so a listener without DNS still
 * serves the test.
 */
@Injectable()
export class GoogleNetblocks implements OnModuleDestroy {
    private readonly logger = new Logger(GoogleNetblocks.name);
    private google = new BlockList();
    private readonly extra = new BlockList();
    private loaded = false;
    private timer: NodeJS.Timeout | null = null;
    private readonly resolveTxt: ResolveTxt;

    constructor(
        @Inject(ENV) env: Pick<Env, 'RELAY_ALLOWED_CIDRS'>,
        @Optional() @Inject(RESOLVE_TXT) resolveTxt?: ResolveTxt,
    ) {
        this.resolveTxt = resolveTxt ?? ((host) => dns.resolveTxt(host));
        for (const cidr of env.RELAY_ALLOWED_CIDRS) addCidr(this.extra, cidr);
    }

    /** Reads Google's list now and keeps it fresh. Never throws: a failed read is logged and tried again. */
    async start(): Promise<void> {
        await this.refresh();
        this.timer = setInterval(() => void this.refresh(), NETBLOCKS_REFRESH_MS);
        this.timer.unref();
    }

    onModuleDestroy(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }

    /** Whether Google's list has been read at least once. */
    get ready(): boolean {
        return this.loaded;
    }

    allows(address: string): boolean {
        const ip = normaliseIp(address);
        if (ip === null) return false;
        const family = isIPv4(ip) ? 'ipv4' : 'ipv6';
        return this.extra.check(ip, family) || this.google.check(ip, family);
    }

    async refresh(): Promise<void> {
        try {
            const list = new BlockList();
            const cidrs = await this.spfRanges(GOOGLE_SPF_DOMAIN, INCLUDE_DEPTH, new Set());
            for (const cidr of cidrs) addCidr(list, cidr);
            if (cidrs.length === 0) throw new Error(`${GOOGLE_SPF_DOMAIN} lists no ip4/ip6 ranges`);
            this.google = list;
            this.loaded = true;
            this.logger.log(`google netblocks: ${cidrs.length} ranges`);
        } catch (error) {
            this.logger.warn(
                `google netblocks not refreshed: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }

    private async spfRanges(domain: string, depth: number, seen: Set<string>): Promise<string[]> {
        if (depth < 0 || seen.has(domain)) return [];
        seen.add(domain);
        const records = (await this.resolveTxt(domain)).map((chunks) => chunks.join(''));
        const spf = records.find((r) => r.startsWith('v=spf1'));
        if (!spf) return [];
        const ranges: string[] = [];
        for (const term of spf.split(/\s+/)) {
            if (term.startsWith('ip4:') || term.startsWith('ip6:')) ranges.push(term.slice(4));
            else if (term.startsWith('include:'))
                ranges.push(...(await this.spfRanges(term.slice(8), depth - 1, seen)));
        }
        return ranges;
    }
}

/** `::ffff:1.2.3.4` (an IPv4 client on a dual-stack listener) reads as `1.2.3.4`. */
export function normaliseIp(address: string): string | null {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    const ip = mapped ? mapped[1]! : address;
    return isIPv4(ip) || isIPv6(ip) ? ip : null;
}

function addCidr(list: BlockList, cidr: string): void {
    const [ip, prefix] = cidr.split('/');
    if (!ip) return;
    const family = isIPv4(ip) ? 'ipv4' : isIPv6(ip) ? 'ipv6' : null;
    if (!family) throw new Error(`not an IP range: ${cidr}`);
    list.addSubnet(ip, prefix === undefined ? (family === 'ipv4' ? 32 : 128) : Number(prefix), family);
}

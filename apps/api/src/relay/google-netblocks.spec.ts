import { describe, expect, it } from 'vitest';
import { GoogleNetblocks, normaliseIp, type ResolveTxt } from './google-netblocks';

const records: Record<string, string[][]> = {
    '_spf.google.com': [['v=spf1 include:_netblocks.google.com ', 'include:_netblocks2.google.com ~all']],
    '_netblocks.google.com': [['v=spf1 ip4:35.190.247.0/24 ip4:64.233.160.0/19 ~all']],
    '_netblocks2.google.com': [['v=spf1 ip6:2001:4860:4000::/36 include:_spf.google.com ~all']],
};
const resolve: ResolveTxt = (host) => {
    const r = records[host];
    return r ? Promise.resolve(r) : Promise.reject(new Error(`ENOTFOUND ${host}`));
};

describe('GoogleNetblocks', () => {
    it("allows Google's SPF ranges (includes followed, cycles ignored) and the extra ones, nobody else", async () => {
        const blocks = new GoogleNetblocks({ RELAY_ALLOWED_CIDRS: ['10.1.2.3', '192.168.0.0/16'] }, resolve);
        expect(blocks.allows('10.1.2.3')).toBe(true); // before any lookup
        expect(blocks.allows('64.233.170.1')).toBe(false);
        await blocks.refresh();
        expect(blocks.ready).toBe(true);
        expect(blocks.allows('64.233.170.1')).toBe(true);
        expect(blocks.allows('::ffff:35.190.247.9')).toBe(true);
        expect(blocks.allows('2001:4860:4001::1')).toBe(true);
        expect(blocks.allows('192.168.4.4')).toBe(true);
        expect(blocks.allows('8.8.8.8')).toBe(false);
        expect(blocks.allows('not-an-ip')).toBe(false);
    });

    it('keeps the last list when a lookup fails', async () => {
        let fail = false;
        const flaky: ResolveTxt = (host) => (fail ? Promise.reject(new Error('timeout')) : resolve(host));
        const blocks = new GoogleNetblocks({ RELAY_ALLOWED_CIDRS: [] }, flaky);
        await blocks.refresh();
        fail = true;
        await blocks.refresh();
        expect(blocks.allows('64.233.170.1')).toBe(true);
    });

    it('refuses a bad extra range at construction', () => {
        expect(() => new GoogleNetblocks({ RELAY_ALLOWED_CIDRS: ['nope/8'] }, resolve)).toThrow(/not an IP range/);
    });

    it('normalises IPv4-mapped addresses', () => {
        expect(normaliseIp('::ffff:1.2.3.4')).toBe('1.2.3.4');
        expect(normaliseIp('1.2.3.4')).toBe('1.2.3.4');
        expect(normaliseIp('::1')).toBe('::1');
        expect(normaliseIp('x')).toBeNull();
    });
});

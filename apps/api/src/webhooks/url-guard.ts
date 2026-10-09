import { lookup as dnsLookup } from 'node:dns';
import { isIP } from 'node:net';
import { BadRequestException } from '@nestjs/common';
import { Agent, type Dispatcher } from 'undici';
import { WEBHOOK_REQUEST_TIMEOUT_MS } from './webhooks.constants';

/**
 * Where a webhook may point. An endpoint URL is the workspace's reach into the network the API
 * runs in: left unchecked, "https://10.0.0.5/admin" is a request the API makes on an attacker's
 * behalf. So a target must be `https:`, name no credentials, and resolve only to public
 * addresses — checked when the endpoint is saved **and** again at connect time, through a
 * pinned lookup, so a name that later points somewhere private is refused then too.
 *
 * `allowPrivate` is the one exception, for a receiver on this machine in development and in the
 * cross-tenant suite; it also admits `http:`. It is an environment flag, never a request option.
 */
export interface UrlGuardOptions {
    allowPrivate: boolean;
}

/** True for an address no public host can own: loopback, RFC 1918, link-local, unspecified, and their IPv6 kin. */
export function isPublicAddress(address: string): boolean {
    const family = isIP(address);
    if (family === 4) return isPublicV4(address);
    if (family === 6) return isPublicV6(address);
    return false;
}

function isPublicV4(address: string): boolean {
    const [a, b] = address.split('.').map(Number) as [number, number, number, number];
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a >= 224) return false; // multicast and reserved
    return true;
}

function isPublicV6(address: string): boolean {
    const lower = address.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isPublicV4(mapped[1]!);
    if (lower === '::' || lower === '::1') return false;
    if (lower.startsWith('fc') || lower.startsWith('fd')) return false; // unique local fc00::/7
    if (/^fe[89ab]/.test(lower)) return false; // link-local fe80::/10
    if (lower.startsWith('ff')) return false; // multicast
    return true;
}

/** Shape rules, with no network: scheme, credentials, and a literal IP's range. */
export function parseWebhookUrl(raw: string, options: UrlGuardOptions): URL {
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        throw new BadRequestException('url is not valid');
    }
    const schemes = options.allowPrivate ? ['https:', 'http:'] : ['https:'];
    if (!schemes.includes(url.protocol)) throw new BadRequestException('url must use https');
    if (url.username || url.password) throw new BadRequestException('url must not carry credentials');
    if (!url.hostname) throw new BadRequestException('url has no host');
    const literal = url.hostname.replace(/^\[|\]$/g, '');
    if (isIP(literal) && !options.allowPrivate && !isPublicAddress(literal)) {
        throw new BadRequestException('url must point at a public address');
    }
    return url;
}

/** Shape rules, then resolution: every address the host resolves to must be public. */
export async function assertWebhookUrl(raw: string, options: UrlGuardOptions): Promise<URL> {
    const url = parseWebhookUrl(raw, options);
    if (options.allowPrivate) return url;
    const literal = url.hostname.replace(/^\[|\]$/g, '');
    if (isIP(literal)) return url;
    const addresses = await new Promise<{ address: string }[]>((resolve, reject) => {
        dnsLookup(literal, { all: true }, (error, list) => (error ? reject(error) : resolve(list)));
    }).catch(() => {
        throw new BadRequestException('url host does not resolve');
    });
    if (addresses.length === 0 || addresses.some((a) => !isPublicAddress(a.address))) {
        throw new BadRequestException('url must point at a public address');
    }
    return url;
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string, family: number) => void;

/**
 * The HTTP client every delivery goes out through: timeouts from the constants, and a lookup
 * that refuses a private answer at connect time, so the address checked is the address used.
 */
export function createWebhookDispatcher(options: UrlGuardOptions): Dispatcher {
    return new Agent({
        headersTimeout: WEBHOOK_REQUEST_TIMEOUT_MS,
        bodyTimeout: WEBHOOK_REQUEST_TIMEOUT_MS,
        connect: {
            timeout: WEBHOOK_REQUEST_TIMEOUT_MS,
            lookup: (hostname: string, _opts: unknown, callback: LookupCallback) => {
                dnsLookup(hostname, { all: true }, (error, list) => {
                    if (error) return callback(error, '', 0);
                    const first = list[0];
                    if (!first) return callback(Object.assign(new Error('no address'), { code: 'ENOTFOUND' }), '', 0);
                    if (!options.allowPrivate && list.some((a) => !isPublicAddress(a.address))) {
                        return callback(
                            Object.assign(new Error('private address refused'), { code: 'EREFUSED' }),
                            '',
                            0,
                        );
                    }
                    callback(null, first.address, first.family);
                });
            },
        },
    });
}

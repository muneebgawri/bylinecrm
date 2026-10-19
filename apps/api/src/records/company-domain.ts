import { bareDomain } from '@bylinecrm/shared';
import { getDomain } from 'tldts';

/**
 * A company's domain (OWN-2c, #201): the registrable domain of whatever was given, by the Public Suffix List.
 * `https://www.Acme.com/about`, `uk.acme.com` and `mail.acme.com` are all `acme.com`; `shop.acme.co.uk` is
 * `acme.co.uk`. Hosts on a shared platform keep their own name — `acme.github.io`, `acme.myshopify.com` — because
 * the list counts `github.io` and `myshopify.com` as suffixes: there, each name is a different company. Null for
 * something that is no company's domain (a bare suffix like `co.uk`, an IP address, a malformed host).
 */
export function companyDomain(value: string | null | undefined): string | null {
    if (!value) return null;
    const host = bareDomain(value);
    if (!host || /^[\d.]+$/.test(host) || host.includes(':')) return null;
    return getDomain(host, { allowPrivateDomains: true }) ?? null;
}

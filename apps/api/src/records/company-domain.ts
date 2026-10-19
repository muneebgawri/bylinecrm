import { bareDomain } from '@bylinecrm/shared';
import { parse } from 'tldts';

/**
 * Labels that make a registrable domain an institution's umbrella rather than one organisation (OWN-2d): under
 * them, each subdomain is its own buyer — `habitation.gouv.qc.ca` is not `osc.gov.on.ca`'s ministry, and
 * `marshall.usc.edu` is a school of its own. A host whose registrable domain carries one keeps its full name.
 */
const INSTITUTIONAL = new Set([
    'gov',
    'gouv',
    'govt',
    'gob',
    'go',
    'gv',
    'gc',
    'government',
    'etat',
    'edu',
    'ac',
    'mil',
    'nhs',
]);

/** National governments whose umbrella domain carries no such label: each department is its own buyer. */
const GOVERNMENT_DOMAINS = new Set([
    'canada.ca',
    'europa.eu',
    'admin.ch',
    'bund.de',
    'belgium.be',
    'overheid.nl',
    'rijksoverheid.nl',
    'regjeringen.no',
    'regeringen.se',
    'valtioneuvosto.fi',
]);

/**
 * Website builders and hosted pages the Public Suffix List does not treat as suffixes (OWN-2d): every site on
 * them is a different company — `sawerigadinggroup.weebly.com` is not Weebly. A host on one keeps its full name.
 * (Platforms the list already covers — `github.io`, `myshopify.com`, `blogspot.com`, `netlify.app` — need no entry.)
 */
const SITE_PLATFORMS = new Set([
    'weebly.com',
    'wixsite.com',
    'wordpress.com',
    'squarespace.com',
    'godaddysites.com',
    'site123.me',
    'jimdosite.com',
    'jimdofree.com',
    'strikingly.com',
    'mystrikingly.com',
    'carrd.co',
    'notion.site',
    'substack.com',
    'mailchimpsites.com',
    'business.site',
    'webnode.page',
    'yolasite.com',
    'tumblr.com',
    'crisp.email',
    'hubspotpagebuilder.com',
    'hs-sites.com',
    'framer.website',
    'webflow.io',
    // Hosted help desks, shops, courses, events and investor pages: `<customer>.<platform>`.
    'zendesk.com',
    'freshdesk.com',
    'helpscoutdocs.com',
    'bandcamp.com',
    'systeme.io',
    'heysummit.com',
    'clientcabin.com',
    'investorroom.com',
    'q4ir.com',
    'gcs-web.com',
    'kajabi.com',
    'mykajabi.com',
    'teachable.com',
    'thinkific.com',
    'podia.com',
    'gumroad.com',
    'typeform.com',
    'bigcartel.com',
    'ecwid.com',
    'square.site',
]);

/** Hosts that are themselves a platform for many sites: kept whole, never folded into their parent. */
const SITE_HOSTS = new Set(['sites.google.com']);

/**
 * A company's domain (OWN-2c/2d, #201): normally the registrable domain of whatever was given, by the Public
 * Suffix List — `https://www.Acme.com/about`, `uk.acme.com` and `mail.acme.com` are all `acme.com`, and
 * `shop.acme.co.uk` is `acme.co.uk`. The host is kept whole (only `www.` dropped) where the registrable domain
 * is not one company:
 *
 * - a government, education or other institutional umbrella (`habitation.gouv.qc.ca`, `marshall.usc.edu`,
 *   `agriculture.canada.ca`);
 * - a website builder or hosted page (`acme.weebly.com`, `acme.zendesk.com`, `sites.google.com`); shared platforms the list already knows
 *   (`acme.github.io`) keep their name by the list itself;
 * - a reserved `.invalid` host — the Twenty importer's marker for a duplicate domain (`acme.com.dup1.invalid`).
 *
 * Null for something that is no company's domain (a bare suffix like `co.uk`, an IP address, a malformed host).
 */
export function companyDomain(value: string | null | undefined): string | null {
    if (!value) return null;
    const host = bareDomain(value);
    if (!host || /^[\d.]+$/.test(host) || host.includes(':')) return null;
    if (host.endsWith('.invalid')) return host;
    const parsed = parse(host, { allowPrivateDomains: true });
    const registrable = parsed.domain;
    if (!registrable) return null;
    if (SITE_PLATFORMS.has(registrable) || GOVERNMENT_DOMAINS.has(registrable)) return host;
    if ([...SITE_HOSTS].some((site) => host === site || host.endsWith(`.${site}`))) return host;
    if (registrable.split('.').some((label) => INSTITUTIONAL.has(label))) return host;
    return registrable;
}

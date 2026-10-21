import type { WonExclusionScope } from '@bylinecrm/shared';
import { isFreeMailDomain } from '../enrichment/email-domain';

/** What a won deal excludes: one address, or one domain. */
export type ExclusionTarget = { address: string; domain?: undefined } | { domain: string; address?: undefined };

/**
 * #242: the exclusion a won deal's customer gets. `address` scope: the point of contact's primary address. `domain`
 * scope: the deal's company's domain, else the contact's company's, else the address's own — unless that domain is
 * free mail (gmail.com excludes nobody's company), when it falls back to the address. `null` when there is no
 * address to start from.
 */
export function exclusionTarget(
    scope: WonExclusionScope,
    address: string | null,
    companyDomain: string | null,
): ExclusionTarget | null {
    if (!address) return null;
    if (scope === 'address') return { address };
    const domain = (companyDomain ?? address.slice(address.lastIndexOf('@') + 1)).toLowerCase();
    return domain && !isFreeMailDomain(domain) ? { domain } : { address };
}

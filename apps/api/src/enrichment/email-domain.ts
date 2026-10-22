import { Injectable } from '@nestjs/common';
import { isFreeMailDomain, type EnrichmentFactKey, type EnrichmentObject } from '@bylinecrm/shared';
import { inferCountry } from '../sequences/country';
import type { Enricher, EnrichmentFinding, EnrichmentSubject } from './enricher.port';

/** The free-mail list lives in `@bylinecrm/shared`, where the web app reads it too. */
export { isFreeMailDomain };

function domainOf(email: string): string | null {
    const at = email.lastIndexOf('@');
    const domain =
        at > 0
            ? email
                  .slice(at + 1)
                  .trim()
                  .toLowerCase()
            : '';
    return domain.includes('.') ? domain : null;
}

/** A company's domain: the one most of its people write from, free mail left out; no people, no answer. */
export function companyDomainOf(emails: readonly string[]): EnrichmentFinding {
    const counts = new Map<string, number>();
    for (const email of emails) {
        const domain = domainOf(email);
        if (!domain || isFreeMailDomain(domain)) continue;
        counts.set(domain, (counts.get(domain) ?? 0) + 1);
    }
    let best: { domain: string; count: number } | null = null;
    for (const [domain, count] of counts) {
        if (!best || count > best.count) best = { domain, count };
    }
    return best
        ? {
              field: 'domain',
              status: 'answered',
              value: best.domain,
              rank: 1,
              note: `${best.count} of ${emails.length} people write from it`,
          }
        : { field: 'domain', status: 'no_answer', note: 'no company address among its people' };
}

/** A person's country from a country-coded domain (`.de`, `.co.uk`); a generic domain says nothing. */
export function personCountryOf(email: string | null): EnrichmentFinding {
    const country = email ? inferCountry({ personCountry: null, companyCountry: null, email }).country : null;
    return country
        ? { field: 'country', status: 'answered', value: country, rank: 1, note: 'the address’s country domain' }
        : { field: 'country', status: 'no_answer', note: 'no country-coded domain in the address' };
}

/** Facts an address itself carries (P4-2): no network, no lookup. */
@Injectable()
export class EmailDomainEnricher implements Enricher {
    readonly source = 'email_domain' as const;

    facts(object: EnrichmentObject): readonly EnrichmentFactKey[] {
        return object === 'person' ? ['country'] : ['domain'];
    }

    applies(subject: EnrichmentSubject): boolean {
        return subject.object === 'person'
            ? Boolean(subject.person?.email)
            : (subject.company?.peopleEmails.length ?? 0) > 0;
    }

    enrich(subject: EnrichmentSubject): Promise<EnrichmentFinding[]> {
        return Promise.resolve(
            subject.object === 'person'
                ? [personCountryOf(subject.person!.email)]
                : [companyDomainOf(subject.company!.peopleEmails)],
        );
    }
}

import { Inject, Injectable } from '@nestjs/common';
import { BYLINE_VENDOR_ONLY_CONFIDENCE, type BylineEnrichment } from '@byline/contract';
import type { EnrichmentFactKey, EnrichmentObject } from '@bylinecrm/shared';
import type { Enricher, EnrichmentFinding, EnrichmentSubject } from '../enrichment/enricher.port';
import { BYLINE_API, type BylineApi } from './byline-api.port';
import { BylineLinks } from './byline-links.service';

// No picture: BylineAI's `avatarUrl` is always null (its only photo source is not exposed).
const PERSON_FACTS: readonly EnrichmentFactKey[] = ['country'];
const COMPANY_FACTS: readonly EnrichmentFactKey[] = ['name', 'domain', 'logo_url', 'linkedin_url'];

/**
 * BylineAI as an enrichment source (BYL-2, P4-2's `Enricher`): asked by address — a person's own, or a company's
 * first person's — with the workspace's key. Its paid layers run under BylineAI's budgets; a refusal (budget spent,
 * rate limit, key refused) throws, so the runner records each fact as failed with BylineAI's reason. A workspace with
 * no API link is not asked.
 */
@Injectable()
export class BylineEnricher implements Enricher {
    readonly source = 'byline' as const;

    constructor(
        @Inject(BYLINE_API) private readonly api: BylineApi,
        private readonly links: BylineLinks,
    ) {}

    facts(object: EnrichmentObject): readonly EnrichmentFactKey[] {
        return object === 'person' ? PERSON_FACTS : COMPANY_FACTS;
    }

    applies(subject: EnrichmentSubject): boolean {
        return subject.workspaceId !== undefined && addressOf(subject) !== null;
    }

    async available(workspaceId: string): Promise<boolean> {
        return (await this.links.linkFor(workspaceId)) !== null;
    }

    async enrich(subject: EnrichmentSubject): Promise<EnrichmentFinding[]> {
        const link = subject.workspaceId ? await this.links.linkFor(subject.workspaceId) : null;
        const address = addressOf(subject);
        if (!link || !address) return [];
        const found = await this.api.enrich(link, address);
        return findings(subject.object, found);
    }
}

function addressOf(subject: EnrichmentSubject): string | null {
    return subject.object === 'person' ? (subject.person?.email ?? null) : (subject.company?.peopleEmails[0] ?? null);
}

/** BylineAI's answer as findings for the object: each fact answered, or no answer. Exported for the suite. */
export function findings(object: EnrichmentObject, found: BylineEnrichment | null): EnrichmentFinding[] {
    // A contact BylineAI holds (scored above a vendor-only match's fixed 0.8) outranks the free sources; a vendor-only
    // match ranks with them.
    const rank = (found?.confidence ?? 0) > BYLINE_VENDOR_ONLY_CONFIDENCE ? 2 : 1;
    const values: Partial<Record<EnrichmentFactKey, string | null | undefined>> =
        object === 'person'
            ? { country: found?.person?.country?.toUpperCase() }
            : {
                  name: found?.company?.name,
                  domain: found?.company?.domain?.toLowerCase(),
                  logo_url: found?.company?.logoUrl,
                  linkedin_url: found?.company?.linkedinUrl,
              };
    return (object === 'person' ? PERSON_FACTS : COMPANY_FACTS).map((field): EnrichmentFinding => {
        const value = values[field]?.trim();
        return value ? { field, status: 'answered', value, rank, note: 'BylineAI' } : { field, status: 'no_answer' };
    });
}

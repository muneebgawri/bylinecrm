import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { EnrichmentFactKey, EnrichmentObject } from '@bylinecrm/shared';
import { ENRICHMENT_FETCH, type EnrichmentFetch } from './fetch.port';
import type { Enricher, EnrichmentFinding, EnrichmentSubject } from './enricher.port';

const FACTS: readonly EnrichmentFactKey[] = ['avatar_url'];

/** Gravatar's public picture URL for an address: the SHA-256 of the lower-cased address; 404 when there is none. */
export function gravatarUrl(email: string): string {
    const hash = createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
    return `https://gravatar.com/avatar/${hash}?d=404&s=256`;
}

/** A person's public Gravatar picture (P4-2): asked for by a `HEAD`, no account, no API key. */
@Injectable()
export class GravatarEnricher implements Enricher {
    readonly source = 'gravatar' as const;

    constructor(@Inject(ENRICHMENT_FETCH) private readonly fetch: EnrichmentFetch) {}

    facts(object: EnrichmentObject): readonly EnrichmentFactKey[] {
        return object === 'person' ? FACTS : [];
    }

    applies(subject: EnrichmentSubject): boolean {
        return subject.object === 'person' && Boolean(subject.person?.email);
    }

    async enrich(subject: EnrichmentSubject): Promise<EnrichmentFinding[]> {
        const url = gravatarUrl(subject.person!.email!);
        return (await this.fetch.check(url))
            ? [{ field: 'avatar_url', status: 'answered', value: url, rank: 1 }]
            : [{ field: 'avatar_url', status: 'no_answer', note: 'no public Gravatar for the address' }];
    }
}

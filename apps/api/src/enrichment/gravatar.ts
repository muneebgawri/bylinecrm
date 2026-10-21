import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { EnrichmentFactKey, EnrichmentObject } from '@bylinecrm/shared';
import { ENRICHMENT_FETCH, FetchFailed, type EnrichmentFetch } from './fetch.port';
import type { Enricher, EnrichmentFinding, EnrichmentSubject } from './enricher.port';

const FACTS: readonly EnrichmentFactKey[] = ['avatar_url'];

/** What a person sees when there is no picture: a normal answer, not a failure. */
export const GRAVATAR_NO_PICTURE = 'No picture';

/**
 * Refusals that say only "no picture to be had here", never "Gravatar is broken": the guarded lookup refusing the
 * host's addresses, the host not resolving, or an answer the connect could not use (`ERR_INVALID_IP_ADDRESS`, the
 * guarded lookup's old single-address answer to Node's `all: true` connect, fixed 2026-10-14). A timeout or a reset
 * stays a failure, so it is asked again.
 */
const NO_PICTURE_REASONS: readonly string[] = ['EREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ERR_INVALID_IP_ADDRESS'];

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
        let found: boolean;
        try {
            found = await this.fetch.check(url);
        } catch (error) {
            if (error instanceof FetchFailed && NO_PICTURE_REASONS.includes(error.reason)) found = false;
            else throw error;
        }
        // `?d=404`: no picture is a 404, a normal "no answer".
        return found
            ? [{ field: 'avatar_url', status: 'answered', value: url, rank: 1 }]
            : [{ field: 'avatar_url', status: 'no_answer', note: GRAVATAR_NO_PICTURE }];
    }
}

import { describe, expect, it } from 'vitest';
import type { EnrichmentSubject } from './enricher.port';
import { FetchFailed, type EnrichmentFetch } from './fetch.port';
import { GRAVATAR_NO_PICTURE, GravatarEnricher, gravatarUrl } from './gravatar';

const subject = { object: 'person', id: 'p1', person: { email: 'Ana@Example.com' } } as unknown as EnrichmentSubject;
const url = gravatarUrl('ana@example.com');

function enricher(check: EnrichmentFetch['check']): GravatarEnricher {
    return new GravatarEnricher({ get: () => Promise.reject(new Error('unused')), check });
}

describe('Gravatar (P4-2)', () => {
    it('answers the picture when Gravatar has one', async () => {
        expect(await enricher(() => Promise.resolve(true)).enrich(subject)).toEqual([
            { field: 'avatar_url', status: 'answered', value: url, rank: 1 },
        ]);
    });

    it('a 404 (no picture) is a normal no answer, shown as "No picture"', async () => {
        expect(await enricher(() => Promise.resolve(false)).enrich(subject)).toEqual([
            { field: 'avatar_url', status: 'no_answer', note: GRAVATAR_NO_PICTURE },
        ]);
    });

    it.each(['EREFUSED', 'ENOTFOUND', 'ERR_INVALID_IP_ADDRESS'])(
        'a %s refusal for its host is no picture, never a failure',
        async (reason) => {
            const findings = await enricher(() => Promise.reject(new FetchFailed(url, reason))).enrich(subject);
            expect(findings).toEqual([{ field: 'avatar_url', status: 'no_answer', note: GRAVATAR_NO_PICTURE }]);
        },
    );

    it('a timeout stays a failure, so it is asked again', async () => {
        await expect(
            enricher(() => Promise.reject(new FetchFailed(url, 'UND_ERR_CONNECT_TIMEOUT'))).enrich(subject),
        ).rejects.toBeInstanceOf(FetchFailed);
    });
});

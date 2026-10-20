import type { BylineEnrichment, BylineVerification } from '@byline/contract';
import { BylineApiError, type BylineApi, type BylineLink } from '../../src/byline/byline-api.port';

/**
 * BylineAI's API in memory (BYL-2): answers set per address, a refusal set for the next asks, and every ask recorded
 * with the key it came with — so a suite can tell which workspace's key reached it.
 */
export class FakeByline implements BylineApi {
    readonly enrichments = new Map<string, BylineEnrichment>();
    readonly verdicts = new Map<string, Omit<BylineVerification, 'email'>>();
    readonly asks: { kind: 'enrich' | 'verify'; email: string; apiKey: string; baseUrl: string }[] = [];
    refusal: BylineApiError | null = null;

    enrich(link: BylineLink, email: string): Promise<BylineEnrichment | null> {
        this.asks.push({ kind: 'enrich', email, apiKey: link.apiKey, baseUrl: link.baseUrl });
        if (this.refusal) return Promise.reject(this.refusal);
        return Promise.resolve(this.enrichments.get(email) ?? null);
    }

    verify(link: BylineLink, email: string): Promise<BylineVerification> {
        this.asks.push({ kind: 'verify', email, apiKey: link.apiKey, baseUrl: link.baseUrl });
        if (this.refusal) return Promise.reject(this.refusal);
        const verdict = this.verdicts.get(email) ?? { verdict: 'unknown', reason: null, provider: 'reacher' };
        return Promise.resolve({ email, ...verdict });
    }

    /** BylineAI's monthly budget, spent. */
    spend(): void {
        this.refusal = new BylineApiError('budget', 'BylineAI’s budget for this is spent: monthly cap of $50 reached');
    }
}

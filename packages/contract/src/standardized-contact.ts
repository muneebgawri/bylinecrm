// BylineAI ingest contract v1.0 (bylineai/packages/contract/src/standardized-contact.ts), as types. BylineAI validates
// it with Zod 3; the CRM runs Zod 4 and never receives it directly (it gets the lead webhook payload), so only the
// shape is mirrored here — the schema stays BylineAI's.

export const SOURCES = [
    'prweb',
    'prnewswire',
    'businesswire',
    'globenewswire',
    'einpresswire',
    'accesswire',
    'newswire_ca',
    'streetinsider',
    'blockchainwire',
    'linkedin',
    'manual',
] as const;
export type BylineSource = (typeof SOURCES)[number];

export interface StandardizedContact {
    schemaVersion: '1.0';
    source: BylineSource;
    producer: 'python_scraper' | 'ts_adapter' | 'browser_extension';
    producerVersion: string;
    naturalId: string;
    sourceUrl: string;
    prTitle: string | null;
    discoveredAt: string;
    email: string;
    firstName: string | null;
    lastName: string | null;
    phone: string | null;
    companyName: string | null;
    jobTitle: string | null;
    country: string | null;
    confidence: number;
    extractionMethod: 'deterministic' | 'ai_fallback' | 'manual';
    rawArtifactRef: string | null;
}

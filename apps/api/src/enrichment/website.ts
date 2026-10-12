import { Inject, Injectable } from '@nestjs/common';
import type { EnrichmentFactKey, EnrichmentObject } from '@bylinecrm/shared';
import { ENRICHMENT_FETCH, FetchFailed, type EnrichmentFetch } from './fetch.port';
import type { Enricher, EnrichmentFinding, EnrichmentSubject } from './enricher.port';

const FACTS: readonly EnrichmentFactKey[] = ['name', 'domain', 'logo_url', 'linkedin_url', 'x_url'];

/** The ranks the page's statements carry: what a site says about itself outranks what a crawler infers. */
const RANK = { siteName: 3, applicationName: 2, title: 1, ogImage: 2, icon: 1, profile: 2, domain: 2 } as const;

/**
 * What a company's home page says about the company (P4-2, FR-CRMS-15): its name (`og:site_name`,
 * else `application-name`, else the title's first segment), its logo (`og:image`, else the icon),
 * its LinkedIn and X profiles (links in the page, never a share link), and the domain it is served
 * from, without `www.`. A pure judgement on the HTML and the URL it came from; what the page does
 * not say is no answer.
 */
export function readWebsite(html: string, finalUrl: string): EnrichmentFinding[] {
    const head = html.slice(0, 200_000);
    const found: EnrichmentFinding[] = [];
    const answer = (field: EnrichmentFactKey, value: string | null | undefined, rank: number, note?: string) => {
        const text = value?.trim();
        found.push(
            text
                ? { field, status: 'answered', value: text, rank, ...(note ? { note } : {}) }
                : { field, status: 'no_answer' },
        );
    };

    const siteName = meta(head, 'property', 'og:site_name') ?? meta(head, 'name', 'og:site_name');
    const appName = meta(head, 'name', 'application-name');
    const title = firstSegment(decode(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1] ?? ''));
    if (siteName) answer('name', siteName, RANK.siteName, 'og:site_name');
    else if (appName) answer('name', appName, RANK.applicationName, 'application-name');
    else answer('name', title, RANK.title, title ? 'title' : undefined);

    const ogImage = meta(head, 'property', 'og:image') ?? meta(head, 'name', 'og:image');
    const icon = linkHref(head, /(?:^|\s)(?:apple-touch-icon|icon|shortcut icon)(?:\s|$)/i);
    if (ogImage) answer('logo_url', absolute(ogImage, finalUrl), RANK.ogImage, 'og:image');
    else answer('logo_url', icon ? absolute(icon, finalUrl) : null, RANK.icon, icon ? 'icon' : undefined);

    answer('linkedin_url', firstHref(html, LINKEDIN), RANK.profile);
    answer(
        'x_url',
        firstHref(html, X_PROFILE, (url) => !/\/(intent|share|home|search|i\/)/i.test(url)),
        RANK.profile,
    );

    try {
        answer('domain', new URL(finalUrl).hostname.toLowerCase().replace(/^www\./, ''), RANK.domain);
    } catch {
        found.push({ field: 'domain', status: 'no_answer' });
    }
    return found;
}

const LINKEDIN = /https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/(?:company|school|showcase)\/[A-Za-z0-9._%-]+\/?/gi;
const X_PROFILE = /https?:\/\/(?:www\.)?(?:x|twitter)\.com\/[A-Za-z0-9_]{1,15}(?![A-Za-z0-9_/])\/?/gi;

function meta(html: string, attribute: 'property' | 'name', key: string): string | null {
    const tags = html.matchAll(/<meta\b[^>]*>/gi);
    for (const [tag] of tags) {
        const attr = new RegExp(`\\b${attribute}\\s*=\\s*["']${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`, 'i');
        if (!attr.test(tag)) continue;
        const content = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
        const value = decode(content?.[1] ?? content?.[2] ?? '').trim();
        if (value) return value;
    }
    return null;
}

function linkHref(html: string, rel: RegExp): string | null {
    for (const [tag] of html.matchAll(/<link\b[^>]*>/gi)) {
        const relValue = /\brel\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
        if (!relValue || !rel.test(relValue[1] ?? relValue[2] ?? '')) continue;
        const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
        const value = (href?.[1] ?? href?.[2] ?? '').trim();
        if (value) return value;
    }
    return null;
}

function firstHref(html: string, pattern: RegExp, accept: (url: string) => boolean = () => true): string | null {
    for (const [url] of html.matchAll(pattern)) {
        if (accept(url)) return url;
    }
    return null;
}

function absolute(href: string, base: string): string | null {
    try {
        const url = new URL(href, base);
        return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
    } catch {
        return null;
    }
}

/** "Acme — Comms for growing teams | Home" → "Acme". */
function firstSegment(title: string): string {
    return title
        .replace(/\s+/g, ' ')
        .split(/\s+[|–—]\s+|\s+-\s+|\s+·\s+/)[0]!
        .trim();
}

function decode(text: string): string {
    return text
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;|&apos;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&nbsp;/g, ' ');
}

/** The company's home page, at `https://<domain>/`: a company with no domain has nothing to visit. */
@Injectable()
export class WebsiteEnricher implements Enricher {
    readonly source = 'website' as const;

    constructor(@Inject(ENRICHMENT_FETCH) private readonly fetch: EnrichmentFetch) {}

    facts(object: EnrichmentObject): readonly EnrichmentFactKey[] {
        return object === 'company' ? FACTS : [];
    }

    applies(subject: EnrichmentSubject): boolean {
        return subject.object === 'company' && Boolean(subject.company?.domain);
    }

    async enrich(subject: EnrichmentSubject): Promise<EnrichmentFinding[]> {
        const url = `https://${subject.company!.domain}/`;
        const page = await this.fetch.get(url);
        if (page.status < 200 || page.status >= 300) throw new FetchFailed(url, `HTTP ${page.status}`);
        if (!/text\/html|application\/xhtml/i.test(page.contentType))
            throw new FetchFailed(url, `not a web page (${page.contentType || 'no content type'})`);
        return readWebsite(page.text, page.finalUrl);
    }
}

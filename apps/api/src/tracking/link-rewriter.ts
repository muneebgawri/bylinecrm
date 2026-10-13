import { escapeHtml } from '../templates/render/serializer';

/**
 * Link rewriting for outreach mail (P3-4, FR-CRMS-8). The HTML part's `href`s are the only thing
 * touched: every `http(s)` link becomes the workspace's short link — one token per distinct URL,
 * however often it appears — and the open pixel is added at the end of the body. `mailto:` and
 * `tel:` are not links to track; the unsubscribe link (P3-1) is passed in as excluded and never
 * rewritten; the text part is never touched, so a plain-text reader sees where they are going.
 */

const HREF = /href="([^"]*)"/g;
const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };

function decode(value: string): string {
    return value.replace(/&(amp|lt|gt|quot|#39);/g, (entity) => ENTITIES[entity] ?? entity);
}

function isHttp(url: string): boolean {
    return /^https?:\/\//i.test(url);
}

/** Each distinct http(s) link, decoded, in order of first appearance, minus the excluded ones. */
export function trackableLinks(html: string, exclude: readonly string[]): string[] {
    const out: string[] = [];
    const skip = new Set(exclude);
    for (const match of html.matchAll(HREF)) {
        const url = decode(match[1]!);
        if (!isHttp(url) || skip.has(url) || out.includes(url)) continue;
        out.push(url);
    }
    return out;
}

/** Every `href` whose decoded URL is in the map becomes its short link, escaped; everything else stays. */
export function rewriteLinks(html: string, shortLinks: ReadonlyMap<string, string>): string {
    return html.replace(HREF, (whole, raw: string) => {
        const short = shortLinks.get(decode(raw));
        return short === undefined ? whole : `href="${escapeHtml(short)}"`;
    });
}

/** The open pixel, once, at the end of the body (or of the fragment). */
export function withOpenPixel(html: string, pixelUrl: string): string {
    const img = `<img src="${escapeHtml(pixelUrl)}" width="1" height="1" alt="">`;
    const end = html.search(/<\/body\s*>/i);
    return end === -1 ? `${html}${img}` : `${html.slice(0, end)}${img}${html.slice(end)}`;
}

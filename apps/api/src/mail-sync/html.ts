import { TEMPLATE_LINK_SCHEMES } from '@bylinecrm/shared';
import sanitizeHtml from 'sanitize-html';
import { safeHref } from '../templates/render/serializer';
import { MAIL_BODY_MAX_CHARS } from './mail-sync.constants';

/**
 * The one sanitiser for synced mail's HTML (P2-2). Like P2-4's serializer it is an allowlist, not
 * a cleaner: structural and text-level tags survive, every attribute is dropped except a link's
 * `href`, and a link survives only to `https:` or `mailto:` (the template rule, `safeHref`).
 * Images are dropped — a remote image in mail is a read receipt for its sender, and the CRM does
 * not fire other people's tracking pixels. Scripts, styles, forms, frames and their contents go.
 */

const ALLOWED_TAGS = [
    'p',
    'br',
    'div',
    'span',
    'b',
    'strong',
    'i',
    'em',
    'u',
    's',
    'a',
    'ul',
    'ol',
    'li',
    'blockquote',
    'pre',
    'code',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'hr',
    'table',
    'thead',
    'tbody',
    'tfoot',
    'tr',
    'td',
    'th',
];

const SCHEMES = TEMPLATE_LINK_SCHEMES.map((scheme) => scheme.replace(/:$/, ''));

const OPTIONS: sanitizeHtml.IOptions = {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: { a: ['href'] },
    allowedSchemes: SCHEMES,
    allowedSchemesAppliedToAttributes: ['href'],
    allowProtocolRelative: false,
    // Content of these is dropped with the tag, not unwrapped into text.
    nonTextTags: ['style', 'script', 'textarea', 'option', 'noscript', 'title', 'head'],
    transformTags: {
        a: (tagName, attribs) => {
            const href = safeHref(attribs['href']);
            return { tagName, attribs: href ? { href } : {} };
        },
    },
};

/** Mail HTML reduced to the allowlist. */
export function sanitizeMailHtml(html: string): string {
    return sanitizeHtml(html, OPTIONS);
}

const BLOCK_BREAK = /<\/(p|div|li|tr|h[1-6]|blockquote|pre|table)>|<br\s*\/?>|<hr\s*\/?>/gi;

/** A text alternative from HTML, for a message that had no `text/plain` part. */
export function textFromHtml(html: string): string {
    const withBreaks = html.replace(BLOCK_BREAK, (m) => `${m}\n`);
    const text = sanitizeHtml(withBreaks, { allowedTags: [], allowedAttributes: {}, nonTextTags: OPTIONS.nonTextTags });
    return decodeEntities(text)
        .replace(/\u00a0/g, ' ')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Gmail's snippet (and sanitised text) carries HTML entities; this is the text they stand for. */
export function decodeEntities(value: string): string {
    return value.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, code: string) => {
        if (code[0] === '#') {
            const point =
                code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
            return Number.isFinite(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : whole;
        }
        return NAMED_ENTITIES[code.toLowerCase()] ?? whole;
    });
}

/** A body part cut to the stored limit, and whether it was cut. */
export function capBody(value: string): { value: string; truncated: boolean } {
    return value.length > MAIL_BODY_MAX_CHARS
        ? { value: value.slice(0, MAIL_BODY_MAX_CHARS), truncated: true }
        : { value, truncated: false };
}

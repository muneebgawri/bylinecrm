import type { RichText, RichTextNode } from './records.js';

/**
 * Compose lint (REP-2, #205, FR-CRMS-24): cheap, client-side warnings in the composer about what spam filters
 * punish — they educate, never block. One function for the web app and the tests.
 */

export const COMPOSE_LINT_CODES = [
    'spam_words',
    'caps_subject',
    'link_only',
    'too_many_links',
    'image_heavy',
    'missing_unsubscribe',
] as const;
export type ComposeLintCode = (typeof COMPOSE_LINT_CODES)[number];

export interface ComposeLintWarning {
    code: ComposeLintCode;
    message: string;
}

/** More links than this in one message is a warning. */
export const COMPOSE_LINT_MAX_LINKS = 3;
/** Fewer words of text than this per image is image-heavy. */
export const COMPOSE_LINT_WORDS_PER_IMAGE = 50;

/** Phrases spam filters weigh heavily; matched as whole words, case-insensitively. */
export const SPAM_TRIGGER_PHRASES: readonly string[] = [
    'act now',
    'buy now',
    'click here',
    'free money',
    'guaranteed',
    '100% free',
    'risk-free',
    'no obligation',
    'limited time',
    'urgent',
    'winner',
    'congratulations',
    'cash bonus',
    'earn money',
    'double your',
    'once in a lifetime',
    'special promotion',
    'this is not spam',
    'dear friend',
    'increase sales',
];

export interface ComposeLintInput {
    subject: string;
    body: RichText;
    /**
     * Mail to someone who did not ask for it one-to-one (a sequence's outreach, or a person whose `source` is
     * not `manual`): it should carry an unsubscribe link.
     */
    bulk: boolean;
}

interface Walked {
    text: string;
    links: number;
    images: number;
    linkText: string;
}

function walk(nodes: readonly RichTextNode[] | undefined, out: Walked): void {
    for (const node of nodes ?? []) {
        if (node.type === 'image') out.images += 1;
        if (node.type === 'variable') out.text += ' x ';
        if (typeof node.text === 'string') {
            out.text += node.text;
            const marks = (node.marks as { type?: string }[] | undefined) ?? [];
            if (marks.some((m) => m.type === 'link')) {
                out.links += 1;
                out.linkText += node.text;
            }
        }
        // A table's cells read as separate words, as a list's items do.
        if (['paragraph', 'hardBreak', 'listItem', 'tableCell', 'tableHeader'].includes(node.type)) out.text += '\n';
        walk(node.content, out);
    }
}

function words(s: string): number {
    return s.split(/\s+/).filter((w) => /\p{L}/u.test(w)).length;
}

/** The warnings for a draft, in a fixed order; empty when nothing stands out. */
export function lintCompose(input: ComposeLintInput): ComposeLintWarning[] {
    const w: Walked = { text: '', links: 0, images: 0, linkText: '' };
    walk(input.body.content, w);
    // Bare URLs typed into the text count as links too.
    const bare = (w.text.match(/https?:\/\/\S+/gi) ?? []).length;
    const links = w.links + bare;
    const out: ComposeLintWarning[] = [];
    const all = `${input.subject}\n${w.text}`.toLowerCase();
    const hits = SPAM_TRIGGER_PHRASES.filter((p) =>
        new RegExp(`(^|[^\\p{L}])${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}])`, 'u').test(all),
    );
    if (hits.length > 0) {
        out.push({
            code: 'spam_words',
            message: `Spam filters weigh ${hits.map((h) => `“${h}”`).join(', ')} — say it plainly.`,
        });
    }
    const letters = input.subject.replace(/[^\p{L}]/gu, '');
    if (letters.length >= 6 && letters === letters.toUpperCase() && letters !== letters.toLowerCase()) {
        out.push({ code: 'caps_subject', message: 'An all-caps subject reads as shouting and as spam.' });
    }
    const ownWords = words(w.text.replace(/https?:\/\/\S+/gi, ' ')) - words(w.linkText);
    if (links > 0 && ownWords < 5) {
        out.push({
            code: 'link_only',
            message: 'A message that is only a link looks like phishing — add a few words.',
        });
    }
    if (links > COMPOSE_LINT_MAX_LINKS) {
        out.push({
            code: 'too_many_links',
            message: `${links} links — more than ${COMPOSE_LINT_MAX_LINKS} hurts deliverability.`,
        });
    }
    if (w.images > 0 && words(w.text) < w.images * COMPOSE_LINT_WORDS_PER_IMAGE) {
        out.push({ code: 'image_heavy', message: 'Mostly images and little text — filters cannot read images.' });
    }
    if (input.bulk && !/unsubscribe|opt[ -]?out/i.test(w.text)) {
        out.push({
            code: 'missing_unsubscribe',
            message: 'This person was not added by hand — include a way to unsubscribe.',
        });
    }
    return out;
}

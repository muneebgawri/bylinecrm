import {
    SIGNATURE_IMAGE_ALT_MAX,
    SIGNATURE_IMAGE_MAX_WIDTH,
    type ImportedSignature,
    type RichText,
    type RichTextNode,
} from '@bylinecrm/shared';
import { parseDocument } from 'htmlparser2';
import { safeHref, safeImageSrc } from '../templates/render/serializer';

/**
 * A Gmail signature (HTML, as `users.settings.sendAs` holds it) as a signature draft (#193). The same
 * allowlist as everything the CRM renders: paragraphs and line breaks, bold, italic, links to `https:` or
 * `mailto:`, and images by `https:` URL with a capped width. Everything else is read for its text or
 * dropped — a script, a style, an event handler never survives, since no attribute is ever copied but a
 * link's target and an image's source, alt text and width. A table is read row by row, a list item by
 * item: Gmail signatures are often laid out in either.
 */

interface DomNode {
    type: string;
    name?: string;
    data?: string;
    attribs?: Record<string, string>;
    children?: DomNode[];
}

type Mark = { type: 'bold' } | { type: 'italic' } | { type: 'link'; attrs: { href: string } };

const BLOCKS = new Set([
    'p',
    'div',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'li',
    'ul',
    'ol',
    'tr',
    'table',
    'tbody',
    'thead',
    'tfoot',
    'blockquote',
    'section',
    'article',
    'header',
    'footer',
    'center',
    'hr',
]);
const SKIPPED = new Set(['script', 'style', 'head', 'title', 'noscript', 'template', 'iframe', 'object', 'svg']);
const BOLD = new Set(['b', 'strong']);
const ITALIC = new Set(['i', 'em']);

class Reader {
    readonly blocks: RichTextNode[] = [];
    droppedImages = 0;
    private line: RichTextNode[] = [];

    read(nodes: DomNode[] | undefined, marks: Mark[]): void {
        for (const node of nodes ?? []) this.node(node, marks);
    }

    private node(node: DomNode, marks: Mark[]): void {
        if (node.type === 'text') {
            const value = (node.data ?? '').replace(/\s+/g, ' ');
            if (value !== '') this.text(value, marks);
            return;
        }
        if (node.type !== 'tag' || !node.name) return;
        const name = node.name.toLowerCase();
        if (SKIPPED.has(name)) return;
        if (name === 'br') {
            this.line.push({ type: 'hardBreak' });
            return;
        }
        if (name === 'img') {
            this.image(node.attribs ?? {});
            return;
        }
        if ((name === 'td' || name === 'th') && this.line.length > 0) this.text(' ', marks);
        const inner = this.marksOf(name, node.attribs ?? {}, marks);
        if (BLOCKS.has(name)) this.flush();
        this.read(node.children, inner);
        if (BLOCKS.has(name)) this.flush();
    }

    private marksOf(name: string, attribs: Record<string, string>, marks: Mark[]): Mark[] {
        const has = (type: Mark['type']) => marks.some((m) => m.type === type);
        if (BOLD.has(name) && !has('bold')) return [...marks, { type: 'bold' }];
        if (ITALIC.has(name) && !has('italic')) return [...marks, { type: 'italic' }];
        if (name === 'a') {
            const href = safeHref(attribs['href']?.trim());
            if (href !== null) return [...marks.filter((m) => m.type !== 'link'), { type: 'link', attrs: { href } }];
        }
        return marks;
    }

    private text(value: string, marks: Mark[]): void {
        const last = this.line.at(-1);
        if (last?.type === 'text' && JSON.stringify(last['marks'] ?? []) === JSON.stringify(marks)) {
            last.text = `${last.text ?? ''}${value}`;
            return;
        }
        this.line.push({ type: 'text', text: value, ...(marks.length ? { marks } : {}) });
    }

    private image(attribs: Record<string, string>): void {
        const src = safeImageSrc(attribs['src']?.trim());
        if (src === null) {
            this.droppedImages += 1;
            return;
        }
        const width = Number.parseInt(attribs['width'] ?? '', 10);
        this.line.push({
            type: 'image',
            attrs: {
                src,
                alt: (attribs['alt'] ?? '').slice(0, SIGNATURE_IMAGE_ALT_MAX),
                ...(Number.isFinite(width) && width > 0 ? { width: Math.min(width, SIGNATURE_IMAGE_MAX_WIDTH) } : {}),
            },
        });
    }

    /** Ends the paragraph being read: spaces at its edges and around its breaks trimmed; nothing kept if it shows nothing. */
    flush(): void {
        const nodes = this.line;
        this.line = [];
        for (let i = 0; i < nodes.length; i += 1) {
            const node = nodes[i]!;
            if (node.type !== 'text') continue;
            const before = nodes[i - 1];
            const after = nodes[i + 1];
            let value = node.text ?? '';
            if (!before || before.type === 'hardBreak') value = value.trimStart();
            if (!after || after.type === 'hardBreak') value = value.trimEnd();
            node.text = value;
        }
        const kept = nodes.filter((n) => n.type !== 'text' || (n.text ?? '') !== '');
        while (kept[0]?.type === 'hardBreak') kept.shift();
        while (kept.at(-1)?.type === 'hardBreak') kept.pop();
        if (kept.length > 0) this.blocks.push({ type: 'paragraph', content: kept });
    }
}

export function signatureFromHtml(html: string): ImportedSignature {
    const reader = new Reader();
    reader.read(parseDocument(html).children as unknown as DomNode[], []);
    reader.flush();
    const signature: RichText | null = reader.blocks.length ? { type: 'doc', content: reader.blocks } : null;
    return { signature, droppedImages: reader.droppedImages };
}

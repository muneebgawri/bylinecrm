import { TEMPLATE_LINK_SCHEMES, type RichText, type RichTextNode } from '@bylinecrm/shared';

/**
 * A template body → an email's HTML and its plain-text alternative, from one walk of the document
 * (P2-4). The one serializer: preview, send and sequences all render through it.
 *
 * An allowlist, not a sanitiser: only the template subset becomes markup — paragraph, headings
 * (2 and 3), bullet and ordered lists, line breaks, bold, italic, and links to `https:` or
 * `mailto:` — and everything else is dropped. Attributes are never copied from the document; the
 * only attribute the output carries is a link's `href`, escaped. Text and variable values are
 * escaped. The API also refuses bodies outside the subset on save, so dropping here is the second
 * line, not the first.
 *
 * A variable whose value is missing is never rendered blank: it is named in `missing`, marked in
 * the HTML (`data-missing-variable`, which the editor's preview highlights) and kept as its
 * `{{path}}` token in the text. A render with anything missing is not sendable.
 */

/** A variable's value, or `null` when it has none. An optional variable resolves to `''`, never `null`. */
export type VariableResolver = (path: string) => string | null;

export interface RenderedBody {
    html: string;
    text: string;
    /** Variable paths with no value, in the order they first appear. */
    missing: string[];
}

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]!);
}

/** The HTML a missing variable leaves; also used for the outreach footer's missing address. */
export function missingMarker(path: string): string {
    const token = `{{${path}}}`;
    return `<span data-missing-variable="${escapeHtml(path)}">${escapeHtml(token)}</span>`;
}

/** A link target the subset allows, normalised; `null` for anything else. */
export function safeHref(href: unknown): string | null {
    if (typeof href !== 'string') return null;
    const trimmed = href.trim();
    if (trimmed !== href || trimmed === '') return null;
    let url: URL;
    try {
        url = new URL(trimmed);
    } catch {
        return null;
    }
    return (TEMPLATE_LINK_SCHEMES as readonly string[]).includes(url.protocol) ? trimmed : null;
}

interface Mark {
    type: string;
    attrs?: Record<string, unknown>;
}

function marksOf(node: RichTextNode): Mark[] {
    return Array.isArray(node['marks']) ? (node['marks'] as Mark[]) : [];
}

function attrsOf(node: RichTextNode): Record<string, unknown> {
    const attrs = node['attrs'];
    return attrs && typeof attrs === 'object' ? (attrs as Record<string, unknown>) : {};
}

/** A heading's level in the subset: 1 and 2 are a level-2 heading, anything deeper is level 3. */
function headingTag(node: RichTextNode): 'h2' | 'h3' {
    const level = Number(attrsOf(node)['level']);
    return Number.isFinite(level) && level <= 2 ? 'h2' : 'h3';
}

class Walker {
    private readonly missing = new Set<string>();

    constructor(private readonly resolve: VariableResolver) {}

    missingPaths(): string[] {
        return [...this.missing];
    }

    /** Block children → `{ html, text }`; text blocks are joined by a blank line. */
    blocks(nodes: RichTextNode[] | undefined, depth: number): { html: string; text: string[] } {
        const html: string[] = [];
        const text: string[] = [];
        for (const node of nodes ?? []) {
            const out = this.block(node, depth);
            if (!out) continue;
            html.push(out.html);
            text.push(out.text);
        }
        return { html: html.join(''), text };
    }

    private block(node: RichTextNode, depth: number): { html: string; text: string } | null {
        switch (node.type) {
            case 'paragraph': {
                const inline = this.inline(node.content);
                return { html: `<p>${inline.html}</p>`, text: inline.text };
            }
            case 'heading': {
                const tag = headingTag(node);
                const inline = this.inline(node.content);
                return { html: `<${tag}>${inline.html}</${tag}>`, text: inline.text };
            }
            case 'bulletList':
            case 'orderedList': {
                const ordered = node.type === 'orderedList';
                const items: string[] = [];
                const lines: string[] = [];
                let n = 0;
                for (const item of node.content ?? []) {
                    if (item.type !== 'listItem') continue;
                    n += 1;
                    const inner = this.blocks(item.content, depth + 1);
                    items.push(`<li>${inner.html}</li>`);
                    const indent = '  '.repeat(depth);
                    const bullet = ordered ? `${n}. ` : '- ';
                    const [first = '', ...rest] = inner.text.join('\n').split('\n');
                    lines.push(`${indent}${bullet}${first}`, ...rest.map((line) => `${indent}  ${line}`.trimEnd()));
                }
                const tag = ordered ? 'ol' : 'ul';
                return { html: `<${tag}>${items.join('')}</${tag}>`, text: lines.join('\n') };
            }
            default:
                // Outside the subset (a script, an image, a code block, …): dropped with its content.
                return null;
        }
    }

    private inline(nodes: RichTextNode[] | undefined): { html: string; text: string } {
        let html = '';
        let text = '';
        for (const node of nodes ?? []) {
            switch (node.type) {
                case 'text': {
                    const value = typeof node.text === 'string' ? node.text : '';
                    const marked = this.marked(value, marksOf(node));
                    html += marked.html;
                    text += marked.text;
                    break;
                }
                case 'variable': {
                    const path = attrsOf(node)['path'];
                    if (typeof path !== 'string' || path === '') break;
                    const value = this.resolve(path);
                    if (value === null) {
                        this.missing.add(path);
                        html += missingMarker(path);
                        text += `{{${path}}}`;
                    } else {
                        html += escapeHtml(value);
                        text += value;
                    }
                    break;
                }
                case 'hardBreak':
                    html += '<br>';
                    text += '\n';
                    break;
                default:
                    // An inline node outside the subset: dropped.
                    break;
            }
        }
        return { html, text };
    }

    /**
     * Text with its marks, applied in one fixed order whatever order the document lists them in —
     * link outermost, then bold, then italic — so the same text always renders the same markup.
     */
    private marked(value: string, marks: Mark[]): { html: string; text: string } {
        const types = new Set(marks.map((m) => m.type));
        let html = escapeHtml(value);
        if (types.has('italic')) html = `<em>${html}</em>`;
        if (types.has('bold')) html = `<strong>${html}</strong>`;
        const href = safeHref(marks.find((m) => m.type === 'link')?.attrs?.['href']);
        if (href === null) return { html, text: value };
        const shown = href === value || href === `mailto:${value}`;
        return { html: `<a href="${escapeHtml(href)}">${html}</a>`, text: shown ? value : `${value} (${href})` };
    }
}

/** Renders a template body. `resolve` gives each variable its value. */
export function renderBody(doc: RichText, resolve: VariableResolver): RenderedBody {
    const walker = new Walker(resolve);
    const out = walker.blocks(doc.content, 0);
    return { html: out.html, text: out.text.join('\n\n').trim(), missing: walker.missingPaths() };
}

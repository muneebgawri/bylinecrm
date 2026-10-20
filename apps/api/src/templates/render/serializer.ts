import {
    SIGNATURE_PLACEMENT_VARIABLE,
    TEMPLATE_IMAGE_MAX_WIDTH,
    TEMPLATE_LINK_SCHEMES,
    type RenderedSignature,
    type RichText,
    type RichTextNode,
} from '@bylinecrm/shared';

/**
 * A template body → an email's HTML and its plain-text alternative, from one walk of the document
 * (P2-4). The one serializer: preview, send and sequences all render through it.
 *
 * An allowlist, not a sanitiser: only the template subset becomes markup — paragraph, headings
 * (2 and 3), bullet and ordered lists, line breaks, bold, italic, and links to `https:` or
 * `mailto:` — and everything else is dropped. Attributes are never copied from the document; the
 * only attribute the output carries is a link's `href`, escaped. Text and variable values are
 * escaped. The API also refuses bodies outside the subset on save, so dropping here is the second
 * line, not the first. Images by `https:` URL (source, alt text and a capped width are the only
 * attributes copied) and tables (rows of cells, with fixed inline styles Gmail and Outlook both draw —
 * collapsed borders, a border and padding on each cell) are opt-in: a template body has both, a
 * signature (#193) images only, and empty lines left out. In the text part an image is its alt text in
 * brackets (a signature's says nothing), and a table is a line a row, its cells joined by ` | `.
 *
 * A variable whose value is missing is never rendered blank: it is named in `missing`, marked in
 * the HTML (`data-missing-variable`, which the editor's preview highlights) and kept as its
 * `{{path}}` token in the text. A render with anything missing is not sendable.
 */

/** A variable's value, or `null` when it has none. An optional variable resolves to `''`, never `null`. */
export type VariableResolver = (path: string) => string | null;

/**
 * How a variable renders, as HTML and text; `null` when it has none. A template's variables are text
 * (`renderBody` escapes the resolver's value); a signature's logo and booking link are an image and a link.
 */
export type VariableRenderer = (path: string) => { html: string; text: string } | null;

/** What a walk may render beyond the template subset. */
export interface WalkOptions {
    /** `image` nodes by `https:` URL, width capped (a body; a signature, #193). */
    images: boolean;
    /** `table` nodes, with inline styles for mail clients (a body, not a signature). */
    tables?: boolean | undefined;
    /** The text part names an image by its alt text, `[alt]` (a body); a signature's image says nothing. */
    imageAlt?: boolean | undefined;
    /** An image's inline style (a body: never wider than the column); absent, none. */
    imageStyle?: string | undefined;
    /**
     * A line — a block, or a stretch between line breaks — with nothing visible on it is left out, so an
     * empty variable leaves no blank line behind (signatures, #193). A template keeps its lines as written.
     */
    dropEmptyLines: boolean;
    /**
     * A template body's `{{sender.signature}}` (#193): the block it sits in is split there and the
     * signature goes between — its own blocks, never inside a line — or nothing, when none applies.
     * Absent: the variable renders as any other.
     */
    signature?: { at: RenderedSignature | null } | undefined;
    /**
     * Email layout with inline styles (a signature, #193): each top-level block wrapped (a table row),
     * a paragraph's own style, a link's style. Absent: plain tags, as a template body is written.
     */
    layout?: { block: (html: string) => string; paragraph: string; link: string } | undefined;
}

const TEMPLATE_WALK: WalkOptions = {
    images: true,
    tables: true,
    imageAlt: true,
    imageStyle: 'max-width:100%;height:auto;border:0;',
    dropEmptyLines: false,
};

/**
 * A table's inline styles: what Gmail (which drops `<style>`) and Outlook (Word's renderer) both draw —
 * collapsed borders, and each cell's own border and padding, since neither inherits them from the table.
 */
export const TABLE_STYLE = {
    table: 'border-collapse:collapse;border:1px solid #d0d5dd;margin:0 0 12px 0;',
    cell: 'border:1px solid #d0d5dd;padding:6px 10px;vertical-align:top;text-align:left;',
    header: 'border:1px solid #d0d5dd;padding:6px 10px;vertical-align:top;text-align:left;font-weight:bold;background-color:#f2f4f7;',
} as const;

/** A cell's span when it has one beyond 1, as the attribute it renders as; `''` for none. */
function spanAttr(name: 'colspan' | 'rowspan', value: unknown): string {
    return Number.isInteger(value) && (value as number) > 1 && (value as number) <= 50
        ? ` ${name}="${value as number}"`
        : '';
}

export interface RenderedBody {
    html: string;
    text: string;
    /** Variable paths with no value, in the order they first appear. */
    missing: string[];
    /** The body named `{{sender.signature}}`: the signature went there (#193), and goes nowhere else. */
    placed: boolean;
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

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** An image source mail may carry: an absolute `https:` URL (or a loopback one, locally), as written; `null` for anything else. */
export function safeImageSrc(src: unknown): string | null {
    if (typeof src !== 'string' || src.trim() !== src || src === '') return null;
    try {
        const url = new URL(src);
        // A loopback `http:` address is a local CRM's own upload (its APP_URL is http there); no recipient
        // could load it, and nothing but https leaves a deployed one.
        const loopback = url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
        return url.protocol === 'https:' || loopback ? src : null;
    } catch {
        return null;
    }
}

/** `<img>` as an email carries it: source, alt text, and the size when known — nothing else. */
export function imageHtml(
    src: string,
    alt: string,
    width?: number | null,
    height?: number | null,
    style?: string,
): string {
    return (
        `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}"` +
        (width ? ` width="${width}"` : '') +
        (height ? ` height="${height}"` : '') +
        (style ? ` style="${style}"` : '') +
        '>'
    );
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

interface Inline {
    html: string;
    text: string;
}

class Walker {
    private readonly missing = new Set<string>();
    placed = false;

    constructor(
        private readonly render: VariableRenderer,
        private readonly options: WalkOptions,
        private readonly maxImageWidth: number,
    ) {}

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
            html.push(depth === 0 && this.options.layout ? this.options.layout.block(out.html) : out.html);
            // A block that shows only an image says nothing in the text part.
            if (out.text !== '' || !this.options.dropEmptyLines) text.push(out.text);
        }
        return { html: html.join(''), text };
    }

    private block(node: RichTextNode, depth: number): { html: string; text: string } | null {
        switch (node.type) {
            case 'paragraph':
            case 'heading': {
                const tag = node.type === 'paragraph' ? 'p' : headingTag(node);
                if (this.options.signature && (node.content ?? []).some(isPlacement)) {
                    return this.placeSignature(node.content ?? [], tag, this.options.signature.at);
                }
                const inline = this.lines(node.content);
                const style = tag === 'p' && this.options.layout ? ` style="${this.options.layout.paragraph}"` : '';
                return inline && { html: `<${tag}${style}>${inline.html}</${tag}>`, text: inline.text };
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
                if (items.length === 0 && this.options.dropEmptyLines) return null;
                const tag = ordered ? 'ol' : 'ul';
                return { html: `<${tag}>${items.join('')}</${tag}>`, text: lines.join('\n') };
            }
            case 'table': {
                // A table only at the top of a body: anywhere else (a list, a cell) it is dropped, as on save.
                if (!this.options.tables || depth !== 0) return null;
                return this.table(node);
            }
            default:
                // Outside the subset (a script, a code block, a block-level image, …): dropped with its content.
                return null;
        }
    }

    /** A table's rows of cells; a cell's paragraphs are its lines, so no paragraph margin opens it up. */
    private table(node: RichTextNode): { html: string; text: string } | null {
        const rows: string[] = [];
        const lines: string[] = [];
        for (const row of node.content ?? []) {
            if (row.type !== 'tableRow') continue;
            const cells: string[] = [];
            const texts: string[] = [];
            for (const cell of row.content ?? []) {
                if (cell.type !== 'tableCell' && cell.type !== 'tableHeader') continue;
                const header = cell.type === 'tableHeader';
                const html: string[] = [];
                const text: string[] = [];
                for (const child of cell.content ?? []) {
                    if (child.type === 'paragraph') {
                        const inline = this.inline(child.content);
                        html.push(inline.html);
                        text.push(inline.text);
                        continue;
                    }
                    const out = this.block(child, 1);
                    if (!out) continue;
                    html.push(out.html);
                    text.push(out.text);
                }
                const attrs = attrsOf(cell);
                const tag = header ? 'th' : 'td';
                cells.push(
                    `<${tag}${spanAttr('colspan', attrs['colspan'])}${spanAttr('rowspan', attrs['rowspan'])} style="${header ? TABLE_STYLE.header : TABLE_STYLE.cell}">${html.join('<br>')}</${tag}>`,
                );
                texts.push(text.join(' ').replace(/\s+/g, ' ').trim());
            }
            if (cells.length === 0) continue;
            rows.push(`<tr>${cells.join('')}</tr>`);
            lines.push(texts.join(' | '));
        }
        if (rows.length === 0) return null;
        return {
            html: `<table cellpadding="0" cellspacing="0" border="1" style="${TABLE_STYLE.table}">${rows.join('')}</table>`,
            text: lines.join('\n'),
        };
    }

    /**
     * A block naming `{{sender.signature}}`, split there: the words before and after stay in blocks of
     * their own (an empty side goes), and the signature — text after the conventional `-- ` line — sits
     * between, once for each time it is named.
     */
    private placeSignature(
        nodes: RichTextNode[],
        tag: string,
        signature: RenderedSignature | null,
    ): { html: string; text: string } | null {
        this.placed = true;
        const html: string[] = [];
        const text: string[] = [];
        const side = (part: RichTextNode[]) => {
            const inline = this.inline(part);
            if (inline.text.trim() === '' && !inline.html.includes('<img')) return;
            html.push(`<${tag}>${inline.html}</${tag}>`);
            text.push(inline.text);
        };
        let part: RichTextNode[] = [];
        for (const node of nodes) {
            if (!isPlacement(node)) {
                part.push(node);
                continue;
            }
            side(part);
            part = [];
            if (signature) {
                html.push(signature.html);
                text.push(`-- \n${signature.text}`);
            }
        }
        side(part);
        return html.length ? { html: html.join(''), text: text.join('\n\n') } : null;
    }

    /**
     * A block's inline content. With `dropEmptyLines`, each stretch between line breaks that shows
     * nothing — no text, no image — is left out, and a block left with no line is `null`.
     */
    private lines(nodes: RichTextNode[] | undefined): Inline | null {
        if (!this.options.dropEmptyLines) return this.inline(nodes);
        const kept: Inline[] = [];
        let line: RichTextNode[] = [];
        for (const node of [...(nodes ?? []), { type: 'hardBreak' }]) {
            if (node.type !== 'hardBreak') {
                line.push(node);
                continue;
            }
            const out = this.inline(line);
            if (out.text.trim() !== '' || out.html.includes('<img')) kept.push(out);
            line = [];
        }
        if (kept.length === 0) return null;
        return { html: kept.map((l) => l.html).join('<br>'), text: kept.map((l) => l.text).join('\n') };
    }

    private inline(nodes: RichTextNode[] | undefined): Inline {
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
                    const value = this.render(path);
                    if (value === null) {
                        this.missing.add(path);
                        html += missingMarker(path);
                        text += `{{${path}}}`;
                    } else {
                        html += value.html;
                        text += value.text;
                    }
                    break;
                }
                case 'image': {
                    if (!this.options.images) break;
                    const attrs = attrsOf(node);
                    const src = safeImageSrc(attrs['src']);
                    if (src === null) break;
                    const alt = typeof attrs['alt'] === 'string' ? attrs['alt'] : '';
                    const width = Number(attrs['width']);
                    html += imageHtml(
                        src,
                        alt,
                        Number.isInteger(width) && width > 0 ? Math.min(width, this.maxImageWidth) : null,
                        null,
                        this.options.imageStyle,
                    );
                    if (this.options.imageAlt && alt.trim() !== '') text += `[${alt.trim()}]`;
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
        const style = this.options.layout ? ` style="${this.options.layout.link}"` : '';
        return {
            html: `<a href="${escapeHtml(href)}"${style}>${html}</a>`,
            text: shown ? value : `${value} (${href})`,
        };
    }
}

/**
 * Renders a template body. `resolve` gives each variable its value; `signature` is what its
 * `{{sender.signature}}` places (#193) — `null` when none applies.
 */
export function renderBody(
    doc: RichText,
    resolve: VariableResolver,
    signature: RenderedSignature | null = null,
): RenderedBody {
    return renderRichText(
        doc,
        (path) => {
            const value = resolve(path);
            return value === null ? null : { html: escapeHtml(value), text: value };
        },
        { ...TEMPLATE_WALK, signature: { at: signature } },
        TEMPLATE_IMAGE_MAX_WIDTH,
    );
}

function isPlacement(node: RichTextNode): boolean {
    return node.type === 'variable' && attrsOf(node)['path'] === SIGNATURE_PLACEMENT_VARIABLE;
}

/** The one walk, for a template body (`renderBody`) and a signature (`renderSignature`, #193). */
export function renderRichText(
    doc: RichText,
    render: VariableRenderer,
    options: WalkOptions,
    maxImageWidth = 0,
): RenderedBody {
    const walker = new Walker(render, options, maxImageWidth);
    const out = walker.blocks(doc.content, 0);
    return {
        html: out.html,
        text: out.text.join('\n\n').trim(),
        missing: walker.missingPaths(),
        placed: walker.placed,
    };
}

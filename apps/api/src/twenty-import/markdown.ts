import type { RichText, RichTextNode } from '@bylinecrm/shared';
import { EMPTY_RICH_TEXT } from '../records/rich-text';

/**
 * A Twenty note or campaign body is markdown; a BylineCRM note is a rich-text document. The
 * conversion keeps structure — paragraphs, headings, bullet and numbered lists, line breaks — and
 * leaves inline markup as text, so nothing a person wrote is lost or guessed at. Headings are
 * levels 2 and 3 (the template subset): a document's level 1 is its title.
 */
export function markdownToRichText(markdown: string): RichText {
    const blocks: RichTextNode[] = [];
    const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
    let paragraph: string[] = [];
    let list: { type: 'bulletList' | 'orderedList'; items: string[] } | null = null;

    const flushParagraph = () => {
        if (paragraph.length === 0) return;
        blocks.push({ type: 'paragraph', content: inline(paragraph) });
        paragraph = [];
    };
    const flushList = () => {
        if (!list) return;
        blocks.push({
            type: list.type,
            content: list.items.map((item) => ({
                type: 'listItem',
                content: [{ type: 'paragraph', content: inline([item]) }],
            })),
        });
        list = null;
    };

    for (const raw of lines) {
        const line = raw.trimEnd();
        const trimmed = line.trim();
        if (trimmed === '') {
            flushParagraph();
            flushList();
            continue;
        }
        const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
        if (heading) {
            flushParagraph();
            flushList();
            blocks.push({
                type: 'heading',
                attrs: { level: heading[1]!.length <= 1 ? 2 : 3 },
                content: [{ type: 'text', text: heading[2]!.trim() }],
            });
            continue;
        }
        const bullet = /^[-*+]\s+(.*)$/.exec(trimmed);
        const numbered = /^\d+[.)]\s+(.*)$/.exec(trimmed);
        if (bullet || numbered) {
            flushParagraph();
            const type = bullet ? 'bulletList' : 'orderedList';
            if (list && list.type !== type) flushList();
            list ??= { type, items: [] };
            list.items.push((bullet ?? numbered)![1]!.trim());
            continue;
        }
        flushList();
        paragraph.push(trimmed);
    }
    flushParagraph();
    flushList();
    return blocks.length === 0 ? EMPTY_RICH_TEXT : { type: 'doc', content: blocks };
}

/** Lines of one paragraph: text nodes joined by hard breaks. */
function inline(lines: string[]): RichTextNode[] {
    const nodes: RichTextNode[] = [];
    lines.forEach((line, index) => {
        if (index > 0) nodes.push({ type: 'hardBreak' });
        nodes.push({ type: 'text', text: line });
    });
    return nodes;
}

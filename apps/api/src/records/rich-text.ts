import type { RichText, RichTextNode } from '@bylinecrm/shared';

/** The empty document, as the editor would produce it; the default body of a note or task. */
export const EMPTY_RICH_TEXT: RichText = { type: 'doc', content: [] };

/** Nodes that end a line when rendered, so their text does not run into the next node's. */
const BLOCK_NODES = new Set(['paragraph', 'heading', 'blockquote', 'listItem', 'codeBlock', 'hardBreak']);

/**
 * The plain text of a rich-text document, for search and previews: every `text` leaf in order,
 * block nodes separated by a newline, whitespace collapsed. One definition; notes and tasks
 * derive `body_text` through it on every write, never anywhere else.
 */
export function richTextToPlain(doc: RichText): string {
    const parts: string[] = [];
    const walk = (node: RichTextNode): void => {
        if (typeof node.text === 'string') parts.push(node.text);
        for (const child of node.content ?? []) walk(child);
        if (BLOCK_NODES.has(node.type)) parts.push('\n');
    };
    for (const child of doc.content ?? []) walk(child);
    return parts
        .join('')
        .replace(/[ \t]+/g, ' ')
        .replace(/\s*\n\s*/g, '\n')
        .trim();
}

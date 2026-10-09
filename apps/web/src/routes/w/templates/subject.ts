import { TEMPLATE_SUBJECT_TOKEN, type RichText, type RichTextNode } from '@bylinecrm/shared';
import { VARIABLE_NODE } from '../../../components/rich-text/variableNode';

/**
 * A template's subject is stored as plain text with `{{path}}` tokens (P2-4); the editor shows it
 * as one line of text and variable chips. These two functions are the only translation between
 * the stored form and the editor's, and they round-trip: what is loaded is what is saved.
 */
export function subjectToDoc(subject: string): RichText {
    const content: RichTextNode[] = [];
    let last = 0;
    for (const match of subject.matchAll(new RegExp(TEMPLATE_SUBJECT_TOKEN.source, 'g'))) {
        const at = match.index;
        if (at > last) content.push({ type: 'text', text: subject.slice(last, at) });
        content.push({ type: VARIABLE_NODE, attrs: { path: match[1] } });
        last = at + match[0].length;
    }
    if (last < subject.length) content.push({ type: 'text', text: subject.slice(last) });
    return { type: 'doc', content: [content.length ? { type: 'paragraph', content } : { type: 'paragraph' }] };
}

/** Several paragraphs (a paste) become one line, joined by a space: a subject has no line breaks. */
export function docToSubject(doc: RichText): string {
    return (doc.content ?? [])
        .map(lineText)
        .filter((line) => line !== '')
        .join(' ');
}

function lineText(node: RichTextNode): string {
    return (node.content ?? [])
        .map((child) => {
            if (child.type === VARIABLE_NODE) {
                const attrs = child.attrs as { path?: unknown } | undefined;
                return `{{${String(attrs?.path ?? '')}}}`;
            }
            return child.text ?? '';
        })
        .join('');
}

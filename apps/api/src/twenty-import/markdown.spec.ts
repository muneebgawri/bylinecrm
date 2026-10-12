import { describe, expect, it } from 'vitest';
import { richTextToPlain } from '../records/rich-text';
import { markdownToRichText } from './markdown';

describe('P4-4 (doc 48 §11): a Twenty note body (markdown) becomes a rich-text document', () => {
    it('paragraphs, headings, bullet and numbered lists and line breaks keep their structure', () => {
        const doc = markdownToRichText(
            '# Call notes\n\nLeft a message.\nWill retry.\n\n- one\n- two\n\n1. first\n2. second\n',
        );
        expect(doc.type).toBe('doc');
        expect(doc.content?.map((n) => n.type)).toEqual(['heading', 'paragraph', 'bulletList', 'orderedList']);
        expect(doc.content?.[0]).toEqual({
            type: 'heading',
            attrs: { level: 2 },
            content: [{ type: 'text', text: 'Call notes' }],
        });
        expect(doc.content?.[1]).toEqual({
            type: 'paragraph',
            content: [
                { type: 'text', text: 'Left a message.' },
                { type: 'hardBreak' },
                { type: 'text', text: 'Will retry.' },
            ],
        });
        expect(doc.content?.[2]).toEqual({
            type: 'bulletList',
            content: [
                { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }] },
                { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'two' }] }] },
            ],
        });
        expect(richTextToPlain(doc)).toBe('Call notes\nLeft a message.\nWill retry.\none\ntwo\nfirst\nsecond');
    });

    it('a heading deeper than the template subset allows is level 3; an empty body is the empty document', () => {
        expect(markdownToRichText('#### deep').content?.[0]).toMatchObject({ type: 'heading', attrs: { level: 3 } });
        expect(markdownToRichText('')).toEqual({ type: 'doc', content: [] });
        expect(markdownToRichText('   \n\n  ')).toEqual({ type: 'doc', content: [] });
    });

    it('inline markup is kept as text: nothing is interpreted, so nothing is lost', () => {
        expect(richTextToPlain(markdownToRichText('**bold** and [a link](https://x.example)'))).toBe(
            '**bold** and [a link](https://x.example)',
        );
    });
});

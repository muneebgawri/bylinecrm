import { describe, expect, it } from 'vitest';
import { EMPTY_RICH_TEXT, richTextToPlain } from './rich-text';

describe('richTextToPlain', () => {
    it('is empty for the empty document', () => {
        expect(richTextToPlain(EMPTY_RICH_TEXT)).toBe('');
    });

    it('joins text leaves in order and separates blocks with one newline', () => {
        const text = richTextToPlain({
            type: 'doc',
            content: [
                { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Met at FinCon' }] },
                {
                    type: 'paragraph',
                    content: [
                        { type: 'text', text: 'Interested in ' },
                        { type: 'text', text: 'EU distribution', marks: [{ type: 'bold' }] },
                        { type: 'text', text: '  for Q4.' },
                    ],
                },
                { type: 'paragraph' },
                {
                    type: 'bulletList',
                    content: [
                        {
                            type: 'listItem',
                            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'CFO signs off' }] }],
                        },
                    ],
                },
            ],
        });
        expect(text).toBe('Met at FinCon\nInterested in EU distribution for Q4.\nCFO signs off');
    });

    it('ignores nodes that carry no text', () => {
        expect(richTextToPlain({ type: 'doc', content: [{ type: 'image', attrs: { src: 'x' } }] })).toBe('');
    });
});

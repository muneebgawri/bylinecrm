import { describe, expect, it } from 'vitest';
import { signatureFromHtml } from './gmail-signature';
import { signatureProblems } from './render-signature';

describe('#193 signatureFromHtml (a Gmail signature as a draft)', () => {
    it('keeps lines, bold, italic, links and https images; drops scripts, handlers and other images', () => {
        const { signature, droppedImages } = signatureFromHtml(
            '<div dir="ltr"><b>Mia Member</b><br><i>Account manager</i><br>' +
                '<a href="https://pinionpartners.co" onclick="x()">pinionpartners.co</a>' +
                '<div><img src="https://cdn.example.com/badge.png" width="900" alt="Badge"></div>' +
                '<img src="http://cdn.example.com/t.gif"><img src="data:image/png;base64,AAAA">' +
                '<script>alert(1)</script><style>p{}</style></div>',
        );
        expect(droppedImages).toBe(2);
        expect(signature).toEqual({
            type: 'doc',
            content: [
                {
                    type: 'paragraph',
                    content: [
                        { type: 'text', text: 'Mia Member', marks: [{ type: 'bold' }] },
                        { type: 'hardBreak' },
                        { type: 'text', text: 'Account manager', marks: [{ type: 'italic' }] },
                        { type: 'hardBreak' },
                        {
                            type: 'text',
                            text: 'pinionpartners.co',
                            marks: [{ type: 'link', attrs: { href: 'https://pinionpartners.co' } }],
                        },
                    ],
                },
                {
                    type: 'paragraph',
                    content: [
                        {
                            type: 'image',
                            attrs: { src: 'https://cdn.example.com/badge.png', alt: 'Badge', width: 600 },
                        },
                    ],
                },
            ],
        });
        expect(signatureProblems(signature!)).toEqual([]);
    });

    it('reads a table layout row by row, and a link off https as its text', () => {
        const { signature } = signatureFromHtml(
            '<table><tr><td><strong>Mia</strong></td><td>Sales</td></tr><tr><td><a href="http://x.example">x.example</a></td></tr></table>',
        );
        expect(signature).toEqual({
            type: 'doc',
            content: [
                {
                    type: 'paragraph',
                    content: [
                        { type: 'text', text: 'Mia', marks: [{ type: 'bold' }] },
                        { type: 'text', text: ' Sales' },
                    ],
                },
                { type: 'paragraph', content: [{ type: 'text', text: 'x.example' }] },
            ],
        });
    });

    it('is null for an empty signature', () => {
        expect(signatureFromHtml('')).toEqual({ signature: null, droppedImages: 0 });
        expect(signatureFromHtml('<div><br></div>')).toEqual({ signature: null, droppedImages: 0 });
    });
});

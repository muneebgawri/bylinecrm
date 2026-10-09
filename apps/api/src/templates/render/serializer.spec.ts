import type { RichText, RichTextNode } from '@bylinecrm/shared';
import { describe, expect, it } from 'vitest';
import { renderBody, escapeHtml } from './serializer';

const doc = (...content: RichTextNode[]): RichText => ({ type: 'doc', content });
const p = (...content: RichTextNode[]): RichTextNode => ({ type: 'paragraph', content });
const text = (value: string, marks?: { type: string; attrs?: Record<string, unknown> }[]): RichTextNode =>
    marks ? { type: 'text', text: value, marks } : { type: 'text', text: value };
const variable = (path: string): RichTextNode => ({ type: 'variable', attrs: { path } });

const values: Record<string, string> = {
    'person.firstName': 'Dana',
    'company.name': 'Acme & Sons <Ltd>',
};
const resolve = (path: string) => values[path] ?? null;

describe('renderBody', () => {
    it('renders the allowed subset to HTML and to plain text', () => {
        const out = renderBody(
            doc(
                { type: 'heading', attrs: { level: 2 }, content: [text('Hello')] },
                p(text('Hi '), variable('person.firstName'), text(',')),
                p(text('bold', [{ type: 'bold' }]), text(' and '), text('italic', [{ type: 'italic' }])),
                {
                    type: 'bulletList',
                    content: [
                        { type: 'listItem', content: [p(text('one'))] },
                        { type: 'listItem', content: [p(text('two'))] },
                    ],
                },
                {
                    type: 'orderedList',
                    content: [{ type: 'listItem', content: [p(text('first'))] }],
                },
                p(text('line'), { type: 'hardBreak' }, text('break')),
                p(text('site', [{ type: 'link', attrs: { href: 'https://example.com/a?b=1&c=2' } }])),
            ),
            resolve,
        );
        expect(out.html).toBe(
            '<h2>Hello</h2>' +
                '<p>Hi Dana,</p>' +
                '<p><strong>bold</strong> and <em>italic</em></p>' +
                '<ul><li><p>one</p></li><li><p>two</p></li></ul>' +
                '<ol><li><p>first</p></li></ol>' +
                '<p>line<br>break</p>' +
                '<p><a href="https://example.com/a?b=1&amp;c=2">site</a></p>',
        );
        expect(out.text).toBe(
            'Hello\n\nHi Dana,\n\nbold and italic\n\n- one\n- two\n\n1. first\n\nline\nbreak\n\nsite (https://example.com/a?b=1&c=2)',
        );
        expect(out.missing).toEqual([]);
    });

    it('escapes variable values in HTML and keeps them literal in text', () => {
        const out = renderBody(doc(p(variable('company.name'))), resolve);
        expect(out.html).toBe('<p>Acme &amp; Sons &lt;Ltd&gt;</p>');
        expect(out.text).toBe('Acme & Sons <Ltd>');
    });

    it('never blanks a missing variable: it is named, marked in HTML, and kept as a token in text', () => {
        const out = renderBody(doc(p(text('Hi '), variable('person.lastName'), variable('person.lastName'))), resolve);
        expect(out.missing).toEqual(['person.lastName']);
        expect(out.html).toBe(
            '<p>Hi <span data-missing-variable="person.lastName">{{person.lastName}}</span>' +
                '<span data-missing-variable="person.lastName">{{person.lastName}}</span></p>',
        );
        expect(out.text).toBe('Hi {{person.lastName}}{{person.lastName}}');
    });

    it('clamps heading levels to 2 and 3', () => {
        const out = renderBody(
            doc(
                { type: 'heading', attrs: { level: 1 }, content: [text('a')] },
                { type: 'heading', attrs: { level: 5 }, content: [text('b')] },
            ),
            resolve,
        );
        expect(out.html).toBe('<h2>a</h2><h3>b</h3>');
    });

    describe('neutralises what an email must never carry', () => {
        it('a script or any other node outside the subset is dropped with its content', () => {
            const out = renderBody(
                doc(
                    { type: 'script', content: [text('alert(1)')] } as RichTextNode,
                    { type: 'image', attrs: { src: 'https://x/y.png' } } as RichTextNode,
                    { type: 'codeBlock', content: [text('rm -rf /')] } as RichTextNode,
                    p(text('kept')),
                ),
                resolve,
            );
            expect(out.html).toBe('<p>kept</p>');
            expect(out.text).toBe('kept');
        });

        it('raw HTML in text is text, never markup', () => {
            const out = renderBody(doc(p(text('<img src=x onerror="alert(1)"><script>alert(2)</script>'))), resolve);
            expect(out.html).toBe(
                '<p>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&lt;script&gt;alert(2)&lt;/script&gt;</p>',
            );
            expect(out.html).not.toMatch(/<img|<script/);
        });

        it.each([
            ['javascript:alert(1)'],
            ['JaVaScRiPt:alert(1)'],
            ['  javascript:alert(1)'],
            ['data:text/html;base64,PHNjcmlwdD4='],
            ['vbscript:msgbox'],
            ['http://plain-http.example'],
            ['//protocol-relative.example'],
            ['not a url'],
        ])('a link to %s keeps its text and loses the link', (href) => {
            const out = renderBody(doc(p(text('click', [{ type: 'link', attrs: { href } }]))), resolve);
            expect(out.html).toBe('<p>click</p>');
            expect(out.text).toBe('click');
        });

        it('a mailto link survives; an attribute-breaking href is escaped', () => {
            const ok = renderBody(
                doc(p(text('mail us', [{ type: 'link', attrs: { href: 'mailto:a@b.co' } }]))),
                resolve,
            );
            expect(ok.html).toBe('<p><a href="mailto:a@b.co">mail us</a></p>');
            const quoted = renderBody(
                doc(p(text('x', [{ type: 'link', attrs: { href: 'https://e.co/"onmouseover="alert(1)' } }]))),
                resolve,
            );
            expect(quoted.html).not.toContain('" onmouseover');
            expect(quoted.html).toContain('&quot;');
        });

        it('event-handler attributes and unknown marks on nodes are ignored', () => {
            const out = renderBody(
                doc({
                    type: 'paragraph',
                    attrs: { onclick: 'alert(1)', style: 'x' },
                    content: [text('t', [{ type: 'underline' }, { type: 'textStyle', attrs: { color: 'red' } }])],
                }),
                resolve,
            );
            expect(out.html).toBe('<p>t</p>');
        });

        it('nested marks are applied in one fixed order, whatever order they arrive in', () => {
            const a = renderBody(
                doc(
                    p(
                        text('x', [
                            { type: 'italic' },
                            { type: 'link', attrs: { href: 'https://e.co' } },
                            { type: 'bold' },
                        ]),
                    ),
                ),
                resolve,
            );
            const b = renderBody(
                doc(
                    p(
                        text('x', [
                            { type: 'bold' },
                            { type: 'italic' },
                            { type: 'link', attrs: { href: 'https://e.co' } },
                        ]),
                    ),
                ),
                resolve,
            );
            expect(a.html).toBe('<p><a href="https://e.co"><strong><em>x</em></strong></a></p>');
            expect(b.html).toBe(a.html);
        });
    });
});

describe('escapeHtml', () => {
    it('escapes the five characters that matter in text and attributes', () => {
        expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
            '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;',
        );
    });
});

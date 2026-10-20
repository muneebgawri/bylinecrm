import { TEMPLATE_TABLE_MAX_COLUMNS, type RichText, type RichTextNode } from '@bylinecrm/shared';
import { describe, expect, it } from 'vitest';
import { signatureProblems } from '../../signatures/render-signature';
import { bodyProblems } from './body-subset';
import { TABLE_STYLE, renderBody } from './serializer';

const doc = (...content: RichTextNode[]): RichText => ({ type: 'doc', content });
const p = (...content: RichTextNode[]): RichTextNode => ({ type: 'paragraph', content });
const text = (value: string, marks?: { type: string }[]): RichTextNode =>
    marks ? { type: 'text', text: value, marks } : { type: 'text', text: value };
const img = (attrs: Record<string, unknown>): RichTextNode => ({ type: 'image', attrs });
const cell = (type: 'tableCell' | 'tableHeader', ...content: RichTextNode[]): RichTextNode => ({
    type,
    attrs: { colspan: 1, rowspan: 1, colwidth: null },
    content,
});
const row = (...cells: RichTextNode[]): RichTextNode => ({ type: 'tableRow', content: cells });
const table = (...rows: RichTextNode[]): RichTextNode => ({ type: 'table', content: rows });
const resolve = (path: string) => (path === 'person.firstName' ? 'Dana' : null);

const SRC = 'https://crm.example.com/api/public/mail-assets/abc.png';
const IMG_STYLE = 'max-width:100%;height:auto;border:0;';

describe('a body’s images', () => {
    it('keeps an https image with its alt text and width (capped at the column), styled to never overflow', () => {
        const out = renderBody(doc(p(text('Our team '), img({ src: SRC, alt: 'The <team>', width: 900 }))), resolve);
        expect(out.html).toBe(
            `<p>Our team <img src="${SRC}" alt="The &lt;team&gt;" width="600" style="${IMG_STYLE}"></p>`,
        );
        // The text part names the image by its alt text.
        expect(out.text).toBe('Our team [The <team>]');
    });

    it('drops an image that is not https, and says nothing for one with no alt text', () => {
        const out = renderBody(
            doc(p(img({ src: 'http://x/y.png' }), img({ src: 'javascript:alert(1)' }), img({ src: SRC }), text('hi'))),
            resolve,
        );
        expect(out.html).toBe(`<p><img src="${SRC}" alt="" style="${IMG_STYLE}">hi</p>`);
        expect(out.text).toBe('hi');
    });

    it('checks an image on save: https only, alt text and width within the caps', () => {
        expect(
            bodyProblems(
                doc(p(img({ src: 'data:image/png;base64,AA', alt: 'x'.repeat(201), width: 0 }), img({ src: SRC }))),
            ),
        ).toEqual([
            { path: 'body.content.0.content.0.attrs.src', message: 'an image is linked by an https: URL' },
            { path: 'body.content.0.content.0.attrs.alt', message: 'alt text is at most 200 characters' },
            { path: 'body.content.0.content.0.attrs.width', message: 'an image is 1 to 600 pixels wide' },
        ]);
    });
});

describe('a body’s tables', () => {
    const priceList = table(
        row(cell('tableHeader', p(text('Plan'))), cell('tableHeader', p(text('Price')))),
        row(
            cell('tableCell', p(text('Basic'))),
            cell('tableCell', p(text('£10'), { type: 'hardBreak' }, text('a month'))),
        ),
        row({ type: 'tableCell', attrs: { colspan: 2, rowspan: 1 }, content: [p(text('Hi ')), p(text('there'))] }),
    );

    it('renders with the inline styles Gmail and Outlook draw: collapsed borders, each cell’s border and padding', () => {
        const out = renderBody(doc(p(text('Prices:')), priceList), resolve);
        expect(out.html).toBe(
            '<p>Prices:</p>' +
                `<table cellpadding="0" cellspacing="0" border="1" style="${TABLE_STYLE.table}">` +
                `<tr><th style="${TABLE_STYLE.header}">Plan</th><th style="${TABLE_STYLE.header}">Price</th></tr>` +
                `<tr><td style="${TABLE_STYLE.cell}">Basic</td><td style="${TABLE_STYLE.cell}">£10<br>a month</td></tr>` +
                `<tr><td colspan="2" style="${TABLE_STYLE.cell}">Hi <br>there</td></tr>` +
                '</table>',
        );
        expect(TABLE_STYLE.table).toContain('border-collapse:collapse');
        expect(TABLE_STYLE.cell).toMatch(/border:1px solid [^;]+;padding:6px 10px/);
    });

    it('reads in the text part as a line a row, its cells joined by " | "', () => {
        expect(renderBody(doc(p(text('Prices:')), priceList), resolve).text).toBe(
            'Prices:\n\nPlan | Price\nBasic | £10 a month\nHi there',
        );
    });

    it('accepts a table on save, and refuses one out of place, malformed or too wide', () => {
        expect(bodyProblems(doc(priceList))).toEqual([]);
        const wide = row(...Array.from({ length: TEMPLATE_TABLE_MAX_COLUMNS + 1 }, () => cell('tableCell', p())));
        expect(
            bodyProblems(
                doc(
                    {
                        type: 'bulletList',
                        content: [{ type: 'listItem', content: [table(row(cell('tableCell', p())))] }],
                    },
                    table(p(text('not a row'))),
                    table(wide),
                    table(row({ type: 'tableCell', attrs: { colspan: 0 }, content: [p()] })),
                    row(cell('tableCell', p())),
                ),
            ),
        ).toEqual([
            { path: 'body.content.0.content.0.content.0', message: '"table" cannot sit in "listItem"' },
            { path: 'body.content.1.content.0', message: '"paragraph" cannot sit in "table"' },
            { path: 'body.content.2.content.0', message: `a table row has 1 to ${TEMPLATE_TABLE_MAX_COLUMNS} cells` },
            { path: 'body.content.3.content.0.content.0.attrs.colspan', message: "a cell's colspan is 1 to 8" },
            { path: 'body.content.4', message: '"tableRow" cannot sit in "doc"' },
        ]);
    });

    it('a nested table is dropped on the way out, as on save', () => {
        const nested = table(row(cell('tableCell', table(row(cell('tableCell', p(text('inner'))))), p(text('outer')))));
        expect(renderBody(doc(nested), resolve).html).not.toContain('inner');
    });

    it('a signature has images but no tables', () => {
        expect(signatureProblems(doc(p(img({ src: SRC, alt: 'Logo' }))))).toEqual([]);
        expect(signatureProblems(doc(table(row(cell('tableCell', p(text('x')))))))).toEqual([
            { path: 'signature.content.0', message: 'a signature cannot contain "table"' },
        ]);
    });
});

import type { RichText, RichTextNode } from '@bylinecrm/shared';
import { generateJSON, getSchema } from '@tiptap/react';
import { describe, expect, it } from 'vitest';
import { extensionsFor, withoutEmptyTables } from './RichTextEditor';

/** Every node of `type` with the type of the node holding it. */
function placed(doc: RichText, type: string): string[] {
    const out: string[] = [];
    const walk = (nodes: RichTextNode[] | undefined, parent: string) =>
        nodes?.forEach((n) => {
            if (n.type === type) out.push(parent);
            walk(n.content, n.type);
        });
    walk(doc.content, 'doc');
    return out;
}

/** How a pasted email signature is often laid out: one cell holding a row of three. */
const NESTED = `<p>Hello</p>
<table><tbody><tr><td>
  <table><tbody><tr><td><p>Logo</p></td><td><p>Evan James</p></td><td><p>evan@example.com</p></td></tr></tbody></table>
</td></tr></tbody></table>
<p>Bye</p>`;

describe('a body’s tables sit only at the top, as the API requires', () => {
    const extensions = extensionsFor('template', false);

    it('a cell or a list item cannot hold a table', () => {
        const schema = getSchema(extensions);
        const table = schema.nodes['table']!;
        expect(schema.nodes['tableCell']!.contentMatch.matchType(table)).toBeNull();
        expect(schema.nodes['tableHeader']!.contentMatch.matchType(table)).toBeNull();
        expect(
            schema.nodes['listItem']!.contentMatch.matchType(schema.nodes['paragraph']!)?.matchType(table),
        ).toBeNull();
        expect(schema.topNodeType.contentMatch.matchType(table)).not.toBeNull();
    });

    it('lays a pasted nested table out flat, keeping its words', () => {
        const doc = generateJSON(NESTED, extensions) as RichText;
        expect(placed(doc, 'table').every((parent) => parent === 'doc')).toBe(true);
        const text = JSON.stringify(doc);
        for (const word of ['Hello', 'Logo', 'Evan James', 'evan@example.com', 'Bye']) expect(text).toContain(word);
    });

    it('takes a table pasted into a list item out to the top', () => {
        const doc = generateJSON(
            '<ul><li><p>one</p><table><tbody><tr><td><p>x</p></td></tr></tbody></table></li></ul>',
            extensions,
        ) as RichText;
        expect(placed(doc, 'table').every((parent) => parent === 'doc')).toBe(true);
    });
});

describe('pasted empty tables are left out', () => {
    const extensions = extensionsFor('template', false);
    const schema = getSchema(extensions);
    const parse = (html: string) => schema.nodeFromJSON(generateJSON(html, extensions));

    it('drops the empty layout table a pasted email carried, keeping the words', () => {
        const doc = parse(
            '<p>Looking forward to hearing from you.</p><table><tbody><tr><td><table><tbody><tr><td><p></p></td><td><p></p></td><td><p></p></td></tr></tbody></table></td></tr></tbody></table>',
        );
        const kept = schema.topNodeType.create(null, withoutEmptyTables(doc.content));
        expect(placed(kept.toJSON() as RichText, 'table')).toEqual([]);
        expect(kept.textContent).toBe('Looking forward to hearing from you.');
    });

    it('keeps a table with words or an image in it', () => {
        const words = parse('<table><tbody><tr><td><p>Price</p></td></tr></tbody></table>');
        expect(withoutEmptyTables(words.content)).toBe(words.content);
        const image = parse(
            '<table><tbody><tr><td><p><img src="https://crm.example.com/a.png" alt=""></p></td></tr></tbody></table>',
        );
        expect(withoutEmptyTables(image.content)).toBe(image.content);
    });
});

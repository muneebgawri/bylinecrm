import type { RichText, RichTextNode } from '@bylinecrm/shared';
import { describe, expect, it } from 'vitest';
import { bodyProblems, variablePathsOf, subjectVariablePaths } from './body-subset';

const doc = (...content: RichTextNode[]): RichText => ({ type: 'doc', content });
const p = (...content: RichTextNode[]): RichTextNode => ({ type: 'paragraph', content });

describe('bodyProblems', () => {
    it('accepts the template subset', () => {
        expect(
            bodyProblems(
                doc(
                    { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'h' }] },
                    p(
                        {
                            type: 'text',
                            text: 'a',
                            marks: [{ type: 'bold' }, { type: 'link', attrs: { href: 'https://e.co' } }],
                        },
                        { type: 'variable', attrs: { path: 'person.firstName' } },
                        { type: 'hardBreak' },
                    ),
                    { type: 'bulletList', content: [{ type: 'listItem', content: [p({ type: 'text', text: 'x' })] }] },
                ),
            ),
        ).toEqual([]);
    });

    it('names every node, mark, level and link it refuses, at its path in the request body', () => {
        expect(
            bodyProblems(
                doc(
                    { type: 'codeBlock', content: [] },
                    { type: 'heading', attrs: { level: 1 }, content: [] },
                    p(
                        { type: 'text', text: 'u', marks: [{ type: 'underline' }] },
                        { type: 'text', text: 'j', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] },
                        { type: 'variable', attrs: {} },
                    ),
                ),
            ),
        ).toEqual([
            { path: 'body.content.0', message: 'a template body cannot contain "codeBlock"' },
            { path: 'body.content.1.attrs.level', message: 'headings are level 2 or 3' },
            { path: 'body.content.2.content.0.marks.0', message: 'a template body cannot use the mark "underline"' },
            {
                path: 'body.content.2.content.1.marks.0.attrs.href',
                message: 'a link must start with https: or mailto:',
            },
            { path: 'body.content.2.content.2.attrs.path', message: 'a variable needs a path' },
        ]);
    });
});

describe('variable paths', () => {
    it('collects body variables with their request-body paths', () => {
        expect(
            variablePathsOf(
                doc(
                    p({ type: 'variable', attrs: { path: 'person.firstName' } }),
                    p({ type: 'text', text: 'x' }, { type: 'variable', attrs: { path: 'person.custom.beat' } }),
                ),
            ),
        ).toEqual([
            { path: 'person.firstName', at: 'body.content.0.content.0' },
            { path: 'person.custom.beat', at: 'body.content.1.content.1' },
        ]);
    });

    it('reads {{ tokens }} from a subject, spaces allowed', () => {
        expect(subjectVariablePaths('Quick one for {{person.firstName}} at {{ company.name }}')).toEqual([
            'person.firstName',
            'company.name',
        ]);
    });
});

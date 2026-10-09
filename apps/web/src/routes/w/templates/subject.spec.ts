import { describe, expect, it } from 'vitest';
import { docToSubject, subjectToDoc } from './subject';

describe('template subject ⇄ editor document', () => {
    it('turns {{path}} tokens into variable nodes and back, unchanged', () => {
        const subject = 'Quick one for {{person.firstName}} at {{company.name}}';
        const doc = subjectToDoc(subject);
        expect(doc.content?.[0]?.content).toEqual([
            { type: 'text', text: 'Quick one for ' },
            { type: 'variable', attrs: { path: 'person.firstName' } },
            { type: 'text', text: ' at ' },
            { type: 'variable', attrs: { path: 'company.name' } },
        ]);
        expect(docToSubject(doc)).toBe(subject);
    });

    it('normalises spaces inside a token to the canonical spelling', () => {
        expect(docToSubject(subjectToDoc('Hi {{ person.firstName }}'))).toBe('Hi {{person.firstName}}');
    });

    it('keeps a subject with no tokens as plain text, and an empty one as an empty line', () => {
        expect(docToSubject(subjectToDoc('Hello there'))).toBe('Hello there');
        expect(subjectToDoc('')).toEqual({ type: 'doc', content: [{ type: 'paragraph' }] });
        expect(docToSubject(subjectToDoc(''))).toBe('');
    });

    it('starts and ends with a variable without inventing text around it', () => {
        const subject = '{{person.firstName}}, a question{{sender.signature}}';
        expect(docToSubject(subjectToDoc(subject))).toBe(subject);
        expect(subjectToDoc('{{deal.name}}').content?.[0]?.content).toEqual([
            { type: 'variable', attrs: { path: 'deal.name' } },
        ]);
    });

    it('joins several paragraphs (a paste) with a space: a subject is one line', () => {
        const doc = {
            type: 'doc' as const,
            content: [
                { type: 'paragraph', content: [{ type: 'text', text: 'One' }] },
                { type: 'paragraph', content: [{ type: 'text', text: 'two' }] },
            ],
        };
        expect(docToSubject(doc)).toBe('One two');
    });
});

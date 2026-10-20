import { lintCompose, type RichText, type RichTextNode } from '@bylinecrm/shared';
import { describe, expect, it } from 'vitest';

const para = (...content: RichTextNode[]): RichText => ({ type: 'doc', content: [{ type: 'paragraph', content }] });
const text = (t: string): RichTextNode => ({ type: 'text', text: t });
const link = (t: string): RichTextNode => ({
    type: 'text',
    text: t,
    marks: [{ type: 'link', attrs: { href: 'https://x.test' } }],
});
const codes = (subject: string, body: RichText, bulk = false) =>
    lintCompose({ subject, body, bulk }).map((w) => w.code);

describe('REP-2 compose lint (FR-CRMS-24)', () => {
    it('is quiet for an ordinary note', () => {
        expect(codes('Lunch on Friday', para(text('Are you free for lunch on Friday near the office?')))).toEqual([]);
    });

    it('flags trigger words, an all-caps subject, a link-only body and too many links', () => {
        expect(codes('ACT NOW TODAY', para(text('Click here, guaranteed results.')))).toEqual([
            'spam_words',
            'caps_subject',
        ]);
        expect(codes('Hi', para(link('see this')))).toEqual(['link_only']);
        expect(
            codes(
                'Links',
                para(text('Some reading for the team this week: '), link('a'), link('b'), link('c'), link('d')),
            ),
        ).toEqual(['too_many_links']);
    });

    it('flags an image-heavy body and a missing unsubscribe on bulk mail only', () => {
        const images: RichText = {
            type: 'doc',
            content: [{ type: 'image' }, { type: 'paragraph', content: [text('Hello there')] }],
        };
        expect(codes('Look', images)).toContain('image_heavy');
        const plain = para(text('A short note about our new product line and pricing for next quarter.'));
        expect(codes('Update', plain, true)).toEqual(['missing_unsubscribe']);
        expect(codes('Update', para(text('A short note. Reply “unsubscribe” to opt out.')), true)).toEqual([]);
    });

    it('reads a table’s cells as separate words, and still calls a body of images and few words image-heavy', () => {
        const cell = (t: string): RichTextNode => ({
            type: 'tableCell',
            content: [{ type: 'paragraph', content: [text(t)] }],
        });
        const table = (...rows: string[][]): RichTextNode => ({
            type: 'table',
            content: rows.map((r) => ({ type: 'tableRow', content: r.map(cell) })),
        });
        const image: RichTextNode = { type: 'image', attrs: { src: 'https://x.test/a.png', alt: 'chart' } };
        const filled: RichText = {
            type: 'doc',
            content: [
                table(['Plan', 'Price'], ['Basic', 'Ten pounds a month']),
                { type: 'paragraph', content: [link('Sign up')] },
            ],
        };
        // Six words of the table's own, read across its cells: not a link-only message.
        expect(codes('Prices', filled)).toEqual([]);
        const sparse: RichText = {
            type: 'doc',
            content: [table(['Hi']), { type: 'paragraph', content: [image, image] }],
        };
        expect(codes('Look', sparse)).toEqual(['image_heavy']);
    });
});

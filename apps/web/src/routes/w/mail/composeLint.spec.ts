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
});

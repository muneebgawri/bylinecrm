import { describe, expect, it } from 'vitest';
import { rewriteLinks, trackableLinks, withOpenPixel } from './link-rewriter';

const html =
    '<p>Read <a href="https://acme.example/report?x=1&amp;y=2">the report</a> and ' +
    '<a href="https://acme.example/report?x=1&amp;y=2">again</a>, or ' +
    '<a href="mailto:dana@acme.example">write</a> / <a href="tel:+15550100">call</a>.</p>' +
    '<hr><p>No more mail <a href="https://crm.example/unsubscribe/tok123">Unsubscribe</a></p>';

/**
 * Link rewriting for outreach mail (P3-4, FR-CRMS-8): every http(s) link in the HTML becomes the
 * workspace's short link — once per distinct URL — except the unsubscribe link (P3-1), which is
 * never rewritten; `mailto:` and `tel:` are not links to track. The text part is left as it is.
 */
describe('FR-CRMS-8 link rewriting', () => {
    it('lists each distinct http(s) link once, decoded, leaving mailto, tel and the unsubscribe link out', () => {
        expect(trackableLinks(html, ['https://crm.example/unsubscribe/tok123'])).toEqual([
            'https://acme.example/report?x=1&y=2',
        ]);
    });

    it('rewrites every occurrence of a link to its short link, escaped, and nothing else', () => {
        const out = rewriteLinks(
            html,
            new Map([['https://acme.example/report?x=1&y=2', 'https://go.acme.example/r/abc_DEF']]),
        );
        expect(out.match(/https:\/\/go\.acme\.example\/r\/abc_DEF/g)).toHaveLength(2);
        expect(out).not.toContain('https://acme.example/report');
        expect(out).toContain('href="mailto:dana@acme.example"');
        expect(out).toContain('href="https://crm.example/unsubscribe/tok123"');
    });

    it('adds the open pixel once, at the end of the body', () => {
        const out = withOpenPixel('<html><body><p>Hi</p></body></html>', 'https://go.acme.example/o/pix');
        expect(out).toBe(
            '<html><body><p>Hi</p><img src="https://go.acme.example/o/pix" width="1" height="1" alt=""></body></html>',
        );
        expect(withOpenPixel('<p>Hi</p>', 'https://go.acme.example/o/pix')).toBe(
            '<p>Hi</p><img src="https://go.acme.example/o/pix" width="1" height="1" alt="">',
        );
    });
});

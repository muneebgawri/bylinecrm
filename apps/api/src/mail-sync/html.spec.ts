import { describe, expect, it } from 'vitest';
import { MAIL_BODY_MAX_CHARS } from './mail-sync.constants';
import { capBody, decodeEntities, sanitizeMailHtml, textFromHtml } from './html';

describe('sanitizeMailHtml', () => {
    it('keeps text-level and structural markup', () => {
        expect(sanitizeMailHtml('<p>Hi <b>Dana</b>,<br>see <em>below</em></p><ul><li>one</li></ul>')).toBe(
            '<p>Hi <b>Dana</b>,<br />see <em>below</em></p><ul><li>one</li></ul>',
        );
    });

    it('drops scripts and styles with their content, and every event handler', () => {
        const out = sanitizeMailHtml(
            '<style>p{color:red}</style><script>alert(1)</script><p onclick="x()" style="x" class="c" id="i">ok</p>',
        );
        expect(out).toBe('<p>ok</p>');
    });

    it('keeps https and mailto links, drops javascript:, data: and protocol-relative ones', () => {
        expect(sanitizeMailHtml('<a href="https://e.com/x">a</a>')).toBe('<a href="https://e.com/x">a</a>');
        expect(sanitizeMailHtml('<a href="mailto:x@e.com">m</a>')).toBe('<a href="mailto:x@e.com">m</a>');
        expect(sanitizeMailHtml('<a href="javascript:alert(1)">j</a>')).toBe('<a>j</a>');
        expect(sanitizeMailHtml('<a href="JaVaScRiPt:alert(1)">j</a>')).toBe('<a>j</a>');
        expect(sanitizeMailHtml('<a href="data:text/html,x">d</a>')).toBe('<a>d</a>');
        expect(sanitizeMailHtml('<a href="//evil.example">p</a>')).toBe('<a>p</a>');
        expect(sanitizeMailHtml('<a href="http://plain.example">h</a>')).toBe('<a>h</a>');
        expect(sanitizeMailHtml('<a href=" https://e.com">w</a>')).toBe('<a>w</a>');
    });

    it('drops images (tracking pixels), frames, forms and SVG', () => {
        const out = sanitizeMailHtml(
            '<img src="https://t.example/p.gif"><iframe src="https://e.com"></iframe><form><input></form><svg onload="x"><a href="https://e.com">s</a></svg><p>t</p>',
        );
        expect(out).not.toMatch(/img|iframe|form|input|svg|onload/);
        expect(out).toContain('<p>t</p>');
    });

    it('neutralises markup smuggled in attributes and comments', () => {
        expect(sanitizeMailHtml('<p title="<script>x</script>">a</p><!-- <script>y</script> -->')).toBe('<p>a</p>');
    });
});

describe('textFromHtml', () => {
    it('keeps line structure and decodes entities', () => {
        expect(textFromHtml('<p>Hi &amp; welcome</p><p>Line&nbsp;two<br>three</p><script>x</script>')).toBe(
            'Hi & welcome\nLine two\nthree',
        );
    });
});

describe('decodeEntities', () => {
    it('decodes named, decimal and hex references and leaves unknown ones', () => {
        expect(decodeEntities('it&#39;s &quot;fine&quot; &#x2713; &bogus;')).toBe('it\'s "fine" ✓ &bogus;');
    });
});

describe('capBody', () => {
    it('cuts at the limit and says so', () => {
        expect(capBody('short')).toEqual({ value: 'short', truncated: false });
        const long = 'x'.repeat(MAIL_BODY_MAX_CHARS + 5);
        const capped = capBody(long);
        expect(capped.truncated).toBe(true);
        expect(capped.value).toHaveLength(MAIL_BODY_MAX_CHARS);
    });
});

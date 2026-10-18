import { BOOKING_LINK_LABEL, SIGNATURE_STARTER, type RichText, type RichTextNode } from '@bylinecrm/shared';
import { describe, expect, it } from 'vitest';
import { renderSignature, signatureProblems, type SignatureValues } from './render-signature';

const doc = (...content: RichTextNode[]): RichText => ({ type: 'doc', content });
const para = (...content: RichTextNode[]): RichTextNode => ({ type: 'paragraph', content });
const v = (path: string): RichTextNode => ({ type: 'variable', attrs: { path } });
const t = (text: string, marks?: object[]): RichTextNode => ({ type: 'text', text, ...(marks ? { marks } : {}) });
const br: RichTextNode = { type: 'hardBreak' };

const FULL: SignatureValues = {
    sender: {
        fullName: 'Mia Member',
        firstName: 'Mia',
        title: 'Account manager',
        phone: '+92 300 1234567',
        bookingLink: 'https://bookings.example.com/mia',
    },
    workspace: {
        name: 'Pinion <Partners>',
        logo: { url: 'https://crm.example.com/api/public/logos/abc.png', width: 300, height: 100 },
    },
};
const BARE: SignatureValues = {
    sender: { fullName: 'Mia Member', firstName: 'Mia', title: null, phone: null, bookingLink: null },
    workspace: { name: 'Pinion', logo: null },
};

describe('#193 renderSignature', () => {
    it('renders the starter with every value: the booking link as a link, the logo as an image', () => {
        const out = renderSignature(SIGNATURE_STARTER, FULL);
        expect(out.html).toBe(
            '<p>Mia Member<br>Account manager</p>' +
                '<p>+92 300 1234567</p>' +
                `<p><a href="https://bookings.example.com/mia">${BOOKING_LINK_LABEL}</a></p>` +
                '<p><img src="https://crm.example.com/api/public/logos/abc.png" alt="Pinion &lt;Partners&gt;" width="300" height="100"></p>',
        );
        expect(out.text).toBe(
            `Mia Member\nAccount manager\n\n+92 300 1234567\n\n${BOOKING_LINK_LABEL}: https://bookings.example.com/mia`,
        );
    });

    it('leaves out a line with nothing on it, rather than showing it broken', () => {
        const out = renderSignature(SIGNATURE_STARTER, BARE);
        expect(out.html).toBe('<p>Mia Member</p>');
        expect(out.text).toBe('Mia Member');
    });

    it('keeps a line with text of its own when a variable on it is empty', () => {
        const out = renderSignature(doc(para(t('Call: '), v('sender.phone'))), BARE);
        expect(out.html).toBe('<p>Call: </p>');
    });

    it('renders an https image with its width capped, and never an image off https', () => {
        const out = renderSignature(
            doc(
                para({ type: 'image', attrs: { src: 'https://cdn.example.com/b.png', alt: 'B"', width: 900 } }),
                para({ type: 'image', attrs: { src: 'http://cdn.example.com/t.gif', alt: '' } }),
            ),
            BARE,
        );
        expect(out.html).toBe('<p><img src="https://cdn.example.com/b.png" alt="B&quot;" width="600"></p>');
        expect(out.text).toBe('');
    });

    it('is empty for an empty signature', () => {
        expect(renderSignature(doc(para()), BARE)).toEqual({ html: '', text: '' });
    });
});

describe('#193 signatureProblems', () => {
    it('accepts the starter and the template subset with images', () => {
        expect(signatureProblems(SIGNATURE_STARTER)).toEqual([]);
        expect(
            signatureProblems(
                doc(
                    para(
                        t('Mia', [{ type: 'bold' }]),
                        br,
                        t('site', [{ type: 'link', attrs: { href: 'https://x.example' } }]),
                    ),
                    para({ type: 'image', attrs: { src: 'https://cdn.example.com/b.png', alt: 'B', width: 120 } }),
                ),
            ),
        ).toEqual([]);
    });

    it('names each problem at its path', () => {
        expect(
            signatureProblems(
                doc(
                    { type: 'codeBlock', content: [t('x')] },
                    para(v('person.firstName')),
                    para({ type: 'image', attrs: { src: 'http://x.example/a.png', alt: '' } }),
                    para({ type: 'image', attrs: { src: 'https://x.example/a.png', alt: 'a', width: 0 } }),
                ),
            )
                .map((p) => p.path)
                .sort(),
        ).toEqual([
            'signature.content.0',
            'signature.content.1.content.0.attrs.path',
            'signature.content.2.content.0.attrs.src',
            'signature.content.3.content.0.attrs.width',
        ]);
    });
});

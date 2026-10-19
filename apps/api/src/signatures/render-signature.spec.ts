import {
    BOOKING_LINK_LABEL,
    SIGNATURE_STARTER,
    socialLinkProblem,
    type RichText,
    type RichTextNode,
} from '@bylinecrm/shared';
import { describe, expect, it } from 'vitest';
import { SIGNATURE_STYLE as S, renderSignature, signatureProblems, type SignatureValues } from './render-signature';

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
        socials: [
            { network: 'linkedin', url: 'https://www.linkedin.com/in/mia' },
            { network: 'x', url: 'https://x.com/mia' },
        ],
    },
    socialIconBase: 'https://crm.example.com/api/public/social-icons/v1',
    workspace: {
        name: 'Pinion <Partners>',
        logo: { url: 'https://crm.example.com/api/public/logos/abc.png', width: 360, height: 120 },
    },
};
const BARE: SignatureValues = {
    sender: { fullName: 'Mia Member', firstName: 'Mia', title: null, phone: null, bookingLink: null, socials: [] },
    socialIconBase: 'https://crm.example.com/api/public/social-icons/v1',
    workspace: { name: 'Pinion', logo: null },
};

describe('#193 renderSignature', () => {
    const table = (...rows: string[]) =>
        `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="${S.table}">` +
        rows.map((r) => `<tr><td style="${S.row}"><p style="${S.line}">${r}</p></td></tr>`).join('') +
        '</table>';

    it('lays the starter out for email: name and title, the logo under them, then phone and booking link', () => {
        const out = renderSignature(SIGNATURE_STARTER, FULL);
        expect(out.html).toBe(
            table(
                `<span style="${S.name}">Mia Member</span><br><span style="${S.title}">Account manager</span>`,
                `<img src="https://crm.example.com/api/public/logos/abc.png" alt="Pinion &lt;Partners&gt;" width="180" height="60" style="${S.logo}">`,
                `+92 300 1234567<br><a href="https://bookings.example.com/mia" style="${S.link}">${BOOKING_LINK_LABEL}</a>`,
                `<a href="https://www.linkedin.com/in/mia" style="${S.socialLink}"><img src="https://crm.example.com/api/public/social-icons/v1/linkedin.png" alt="LinkedIn" width="20" height="20" style="${S.socialIcon}"></a>` +
                    `<a href="https://x.com/mia" style="${S.socialLink}"><img src="https://crm.example.com/api/public/social-icons/v1/x.png" alt="X" width="20" height="20" style="${S.socialIcon}"></a>`,
            ),
        );
        expect(out.text).toBe(
            `Mia Member\nAccount manager\n\n+92 300 1234567\n${BOOKING_LINK_LABEL}: https://bookings.example.com/mia\n\n` +
                'LinkedIn: https://www.linkedin.com/in/mia\nX: https://x.com/mia',
        );
    });

    it('shows a logo at half its stored size, so it is sharp on high-density screens', () => {
        const small = {
            ...FULL,
            workspace: { ...FULL.workspace, logo: { ...FULL.workspace.logo!, width: 120, height: 40 } },
        };
        expect(renderSignature(doc(para(v('workspace.logo'))), small).html).toContain('width="60" height="20"');
    });

    it('leaves out a line with nothing on it, rather than showing it broken', () => {
        const out = renderSignature(SIGNATURE_STARTER, BARE);
        expect(out.html).toBe(table(`<span style="${S.name}">Mia Member</span>`));
        expect(out.text).toBe('Mia Member');
    });

    it('keeps a line with text of its own when a variable on it is empty', () => {
        const out = renderSignature(doc(para(t('Call: '), v('sender.phone'))), BARE);
        expect(out.html).toBe(table('Call: '));
    });

    it('styles a link written into the signature like the booking link', () => {
        const out = renderSignature(
            doc(para(t('site', [{ type: 'link', attrs: { href: 'https://pinionnewswire.com' } }]))),
            BARE,
        );
        expect(out.html).toBe(table(`<a href="https://pinionnewswire.com" style="${S.link}">site</a>`));
    });

    it('renders an https image with its width capped, and never an image off https', () => {
        const out = renderSignature(
            doc(
                para({ type: 'image', attrs: { src: 'https://cdn.example.com/b.png', alt: 'B"', width: 900 } }),
                para({ type: 'image', attrs: { src: 'http://cdn.example.com/t.gif', alt: '' } }),
            ),
            BARE,
        );
        expect(out.html).toBe(table('<img src="https://cdn.example.com/b.png" alt="B&quot;" width="600">'));
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

describe('#193 socialLinkProblem', () => {
    it('takes an https profile on the network’s own site, a subdomain included', () => {
        expect(socialLinkProblem('linkedin', 'https://www.linkedin.com/in/mia')).toBeNull();
        expect(socialLinkProblem('x', 'https://twitter.com/mia')).toBeNull();
        expect(socialLinkProblem('telegram', 'https://t.me/mia')).toBeNull();
        expect(socialLinkProblem('youtube', 'https://youtube.com/@mia')).toBeNull();
    });

    it('refuses another site, a look-alike host, and anything not https', () => {
        expect(socialLinkProblem('linkedin', 'https://evil.example.com/in/mia')).not.toBeNull();
        expect(socialLinkProblem('linkedin', 'https://linkedin.com.evil.example/in/mia')).not.toBeNull();
        expect(socialLinkProblem('facebook', 'http://facebook.com/mia')).not.toBeNull();
        expect(socialLinkProblem('instagram', 'javascript:alert(1)')).not.toBeNull();
    });
});

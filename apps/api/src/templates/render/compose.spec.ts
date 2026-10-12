import {
    DEFAULT_UNSUBSCRIBE_FOOTER_TEXT,
    MISSING_POSTAL_ADDRESS,
    UNSUBSCRIBE_URL_PLACEHOLDER,
    type MailSettings,
    type RichText,
} from '@bylinecrm/shared';
import { describe, expect, it } from 'vitest';
import { formatPostalAddress } from '@bylinecrm/shared';
import { composeEmail, withUnsubscribeUrl, renderSubject } from './compose';

const body: RichText = {
    type: 'doc',
    content: [
        {
            type: 'paragraph',
            content: [
                { type: 'text', text: 'Hi ' },
                { type: 'variable', attrs: { path: 'person.firstName' } },
            ],
        },
    ],
};
const values: Record<string, string> = { 'person.firstName': 'Dana', 'company.name': 'Acme' };
const resolve = (path: string) => values[path] ?? null;

const address = { line1: '123 Main St', line2: null, city: 'Austin', region: 'TX', postalCode: '78701', country: 'US' };
const settings: MailSettings = {
    postalAddress: address,
    defaultSenderName: null,
    unsubscribeFooterText: DEFAULT_UNSUBSCRIBE_FOOTER_TEXT,
};

describe('renderSubject', () => {
    it('fills tokens and keeps a missing one as its token, named once per use', () => {
        expect(renderSubject('For {{person.firstName}} at {{ company.name }} ({{deal.name}})', resolve)).toEqual({
            subject: 'For Dana at Acme ({{deal.name}})',
            missing: ['deal.name'],
        });
    });
});

describe('composeEmail', () => {
    it('a personal template has no footer and is sendable when every variable resolves', () => {
        const email = composeEmail({ kind: 'personal', subject: 'Hi {{person.firstName}}', body }, resolve, settings);
        expect(email).toEqual({
            subject: 'Hi Dana',
            html: '<p>Hi Dana</p>',
            text: 'Hi Dana',
            missing: [],
            sendable: true,
        });
    });

    it('an outreach template always carries the unsubscribe link and the postal address', () => {
        const email = composeEmail({ kind: 'outreach', subject: 'Hi', body }, resolve, settings);
        expect(email.html).toBe(
            '<p>Hi Dana</p><hr>' +
                `<p>${DEFAULT_UNSUBSCRIBE_FOOTER_TEXT} <a href="${UNSUBSCRIBE_URL_PLACEHOLDER}">Unsubscribe</a></p>` +
                '<p>123 Main St, Austin, TX, 78701, United States</p>',
        );
        expect(email.text).toBe(
            `Hi Dana\n\n--\n${DEFAULT_UNSUBSCRIBE_FOOTER_TEXT} Unsubscribe: ${UNSUBSCRIBE_URL_PLACEHOLDER}\n123 Main St, Austin, TX, 78701, United States`,
        );
        expect(email.sendable).toBe(true);
    });

    it('the footer is added even when the body is empty — nothing in the body can remove it', () => {
        const email = composeEmail(
            { kind: 'outreach', subject: 'x', body: { type: 'doc', content: [] } },
            resolve,
            settings,
        );
        expect(email.html).toContain(UNSUBSCRIBE_URL_PLACEHOLDER);
        expect(email.text.startsWith('--\n')).toBe(true);
    });

    it('an outreach render with no postal address is not sendable and says why', () => {
        const email = composeEmail({ kind: 'outreach', subject: 'Hi {{person.lastName}}', body }, resolve, {
            ...settings,
            postalAddress: null,
        });
        expect(email.missing).toEqual(['person.lastName', MISSING_POSTAL_ADDRESS]);
        expect(email.sendable).toBe(false);
        expect(email.html).toContain(`data-missing-variable="${MISSING_POSTAL_ADDRESS}"`);
        expect(email.text).toContain(`{{${MISSING_POSTAL_ADDRESS}}}`);
    });

    it('a missing variable in the subject and body is named once, in order of first use', () => {
        const email = composeEmail(
            {
                kind: 'personal',
                subject: '{{deal.name}}',
                body: {
                    type: 'doc',
                    content: [
                        {
                            type: 'paragraph',
                            content: [
                                { type: 'variable', attrs: { path: 'person.city' } },
                                { type: 'variable', attrs: { path: 'deal.name' } },
                            ],
                        },
                    ],
                },
            },
            resolve,
            settings,
        );
        expect(email.missing).toEqual(['deal.name', 'person.city']);
        expect(email.sendable).toBe(false);
    });
});

describe('formatPostalAddress', () => {
    it('skips empty parts', () => {
        expect(formatPostalAddress({ ...address, region: null, line2: 'Suite 4' })).toBe(
            '123 Main St, Suite 4, Austin, 78701, United States',
        );
    });

    it('#76 names the country in the footer: the shared function the web preview uses too', () => {
        const email = composeEmail({ kind: 'outreach', subject: 'Hi', body }, resolve, settings);
        expect(email.text).toContain('123 Main St, Austin, TX, 78701, United States');
    });
});

describe('FR-CRMS-7 the unsubscribe link, resolved per recipient', () => {
    const url = 'https://crm.example/unsubscribe/abc_DEF-123';

    it('replaces the footer placeholder in the HTML and the text', () => {
        const email = withUnsubscribeUrl(
            composeEmail({ kind: 'outreach', subject: 'Hi', body: { type: 'doc', content: [] } }, resolve, settings),
            url,
        );
        expect(email.html).toContain(`<a href="${url}">Unsubscribe</a>`);
        expect(email.text).toContain(`Unsubscribe: ${url}`);
        expect(email.html).not.toContain(UNSUBSCRIBE_URL_PLACEHOLDER);
        expect(email.text).not.toContain(UNSUBSCRIBE_URL_PLACEHOLDER);
    });

    it('escapes the URL in the HTML', () => {
        const email = withUnsubscribeUrl(
            { html: `<a href="${UNSUBSCRIBE_URL_PLACEHOLDER}">x</a>`, text: '' },
            'https://crm.example/u?a=1&b=2',
        );
        expect(email.html).toBe('<a href="https://crm.example/u?a=1&amp;b=2">x</a>');
    });

    it('refuses anything but an absolute http(s) URL', () => {
        expect(() => withUnsubscribeUrl({ html: '', text: '' }, 'javascript:alert(1)')).toThrow();
    });
});

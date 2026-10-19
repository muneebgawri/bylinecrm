import { describe, expect, it } from 'vitest';
import { companyDomain } from './company-domain';

describe('companyDomain (OWN-2c, FR-CRMS-20)', () => {
    it('is the registrable domain: www., any subdomain, a scheme, a path and case are the same company', () => {
        for (const v of [
            'acme.com',
            'www.acme.com',
            'uk.acme.com',
            'mail.eu.acme.com',
            'https://www.Acme.com/about',
            'ACME.COM.',
        ]) {
            expect(companyDomain(v), v).toBe('acme.com');
        }
    });

    it('keeps a multi-part public suffix whole', () => {
        expect(companyDomain('shop.acme.co.uk')).toBe('acme.co.uk');
        expect(companyDomain('www.acme.com.au')).toBe('acme.com.au');
    });

    it('keeps each name on a shared platform its own company', () => {
        expect(companyDomain('acme.github.io')).toBe('acme.github.io');
        expect(companyDomain('blog.acme.github.io')).toBe('acme.github.io');
        expect(companyDomain('acme.myshopify.com')).not.toBe(companyDomain('other.myshopify.com'));
    });

    it('is nobody’s for a bare suffix, an IP address or nothing', () => {
        expect(companyDomain('co.uk')).toBeNull();
        expect(companyDomain('10.0.0.1')).toBeNull();
        expect(companyDomain('')).toBeNull();
        expect(companyDomain(null)).toBeNull();
    });
});

import { describe, expect, it } from 'vitest';
import { companyDomain } from './company-domain';

describe('companyDomain (OWN-2c/2d, FR-CRMS-20)', () => {
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
        expect(companyDomain('help.zoho.com')).toBe('zoho.com');
        expect(companyDomain('us.dlink.com')).toBe('dlink.com');
    });

    it('keeps a multi-part public suffix whole', () => {
        expect(companyDomain('shop.acme.co.uk')).toBe('acme.co.uk');
        expect(companyDomain('www.acme.com.au')).toBe('acme.com.au');
    });

    it('keeps each site on a shared platform or website builder its own company', () => {
        expect(companyDomain('acme.github.io')).toBe('acme.github.io');
        expect(companyDomain('blog.acme.github.io')).toBe('acme.github.io');
        expect(companyDomain('acme.myshopify.com')).not.toBe(companyDomain('other.myshopify.com'));
        expect(companyDomain('sawerigadinggroup.weebly.com')).toBe('sawerigadinggroup.weebly.com');
        expect(companyDomain('www.sawerigadinggroup.weebly.com')).toBe('sawerigadinggroup.weebly.com');
        expect(companyDomain('deversifi.on.crisp.email')).toBe('deversifi.on.crisp.email');
        expect(companyDomain('mangoanimate.zendesk.com')).toBe('mangoanimate.zendesk.com');
        expect(companyDomain('eqb.investorroom.com')).toBe('eqb.investorroom.com');
        expect(companyDomain('sites.google.com')).toBe('sites.google.com');
        expect(companyDomain('cloud.google.com')).toBe('google.com');
    });

    it('keeps government and education units apart: each department or school is its own buyer', () => {
        for (const host of [
            'habitation.gouv.qc.ca',
            'osc.gov.on.ca',
            'careerswales.gov.wales',
            'outsource.gov.uz',
            'marshall.usc.edu',
            'tuck.dartmouth.edu',
            'mx.nthu.edu.tw',
            'ctie.etat.lu',
            'agriculture.canada.ca',
            'inspection.canada.ca',
        ]) {
            expect(companyDomain(host), host).toBe(host);
        }
        expect(companyDomain('www.marshall.usc.edu')).toBe('marshall.usc.edu');
        expect(companyDomain('usc.edu')).toBe('usc.edu');
    });

    it('leaves the importer’s .invalid duplicate markers as they are', () => {
        expect(companyDomain('edelman.com.dup1.invalid')).toBe('edelman.com.dup1.invalid');
        expect(companyDomain('bmo.com.dup1.invalid')).not.toBe(companyDomain('canada.ca.dup1.invalid'));
    });

    it('is nobody’s for a bare suffix, an IP address or nothing', () => {
        expect(companyDomain('co.uk')).toBeNull();
        expect(companyDomain('10.0.0.1')).toBeNull();
        expect(companyDomain('')).toBeNull();
        expect(companyDomain(null)).toBeNull();
    });
});

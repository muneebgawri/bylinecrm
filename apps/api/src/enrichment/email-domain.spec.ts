import { describe, expect, it } from 'vitest';
import { companyDomainOfAddress } from '@bylinecrm/shared';
import { companyDomainOf, isFreeMailDomain, personCountryOf } from './email-domain';

/** The email-addresses source (P4-2, FR-CRMS-15): facts an address itself carries, no network. */
describe('FR-CRMS-15 the email-addresses source', () => {
    it('knows the free-mail providers nobody’s company is at', () => {
        for (const domain of [
            'gmail.com',
            'googlemail.com',
            'outlook.com',
            'hotmail.co.uk',
            'yahoo.fr',
            'icloud.com',
            'proton.me',
        ]) {
            expect(isFreeMailDomain(domain), domain).toBe(true);
        }
        expect(isFreeMailDomain('acme.example')).toBe(false);
    });

    it('reads the company domain a person’s address is at, and none at free mail', () => {
        expect(companyDomainOfAddress('Dana@WWW.Acme.example')).toBe('acme.example');
        expect(companyDomainOfAddress('dana@gmail.com')).toBeNull();
        expect(companyDomainOfAddress('dana@localhost')).toBeNull();
        expect(companyDomainOfAddress('no-at-sign')).toBeNull();
        expect(companyDomainOfAddress(null)).toBeNull();
    });

    it('reads a company’s domain as the one most of its people write from, free mail excluded', () => {
        expect(companyDomainOf(['a@acme.example', 'b@gmail.com', 'c@Acme.example', 'd@other.example'])).toMatchObject({
            status: 'answered',
            value: 'acme.example',
        });
        expect(companyDomainOf(['a@gmail.com', 'b@outlook.com'])).toMatchObject({ status: 'no_answer' });
        expect(companyDomainOf([])).toMatchObject({ status: 'no_answer' });
    });

    it('reads a person’s country from a country-coded domain, and nothing from a generic one', () => {
        expect(personCountryOf('tom@halepr.co.uk')).toMatchObject({ status: 'answered', value: 'GB' });
        expect(personCountryOf('tom@halepr.de')).toMatchObject({ status: 'answered', value: 'DE' });
        expect(personCountryOf('tom@halepr.com')).toMatchObject({ status: 'no_answer' });
        expect(personCountryOf(null)).toMatchObject({ status: 'no_answer' });
    });
});

import { describe, expect, it } from 'vitest';
import { countryFromName, countryFromTld, inferCountry } from './country';

describe('FR-CRMS-11 / FR-CRMS-12 a recipient’s country, as inferred', () => {
    it('reads a country-code TLD, with .uk meaning GB, and nothing from a generic TLD', () => {
        expect(countryFromTld('lena@kraft.de')).toBe('DE');
        expect(countryFromTld('tom@halepr.co.uk')).toBe('GB');
        expect(countryFromTld('ana@agency.ca')).toBe('CA');
        expect(countryFromTld('info@bigpr.com')).toBeNull();
        expect(countryFromTld('x@studio.agency')).toBeNull();
        // `.eu` is not a country.
        expect(countryFromTld('x@brand.eu')).toBeNull();
    });

    it('reads an ISO code or an English country name, case-insensitively', () => {
        expect(countryFromName('de')).toBe('DE');
        expect(countryFromName('Germany')).toBe('DE');
        expect(countryFromName('united kingdom')).toBe('GB');
        expect(countryFromName('United States')).toBe('US');
        expect(countryFromName('Atlantis')).toBeNull();
        expect(countryFromName('')).toBeNull();
        expect(countryFromName(null)).toBeNull();
    });

    it('prefers the person’s own country, then the company’s, then the address’s TLD', () => {
        expect(inferCountry({ personCountry: 'FR', companyCountry: 'Germany', email: 'a@b.ca' })).toEqual({
            country: 'FR',
            from: 'person',
        });
        expect(inferCountry({ personCountry: null, companyCountry: 'Germany', email: 'a@b.ca' })).toEqual({
            country: 'DE',
            from: 'company',
        });
        expect(inferCountry({ personCountry: null, companyCountry: null, email: 'a@b.ca' })).toEqual({
            country: 'CA',
            from: 'email',
        });
        expect(inferCountry({ personCountry: null, companyCountry: 'Narnia', email: 'a@b.com' })).toEqual({
            country: null,
            from: null,
        });
    });
});

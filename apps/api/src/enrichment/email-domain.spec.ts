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

    it('reads a provider named by an ordinary word as free mail only at its own domains', () => {
        // A distinctive provider's name is its own under any suffix, a mistyped one included.
        for (const domain of [
            'gmail.con',
            'yahoo.comm',
            'aol.co.uk',
            'gmx.ch',
            'live.co.uk',
            'mail.ru',
            'pm.me',
            'me.com',
        ]) {
            expect(isFreeMailDomain(domain), domain).toBe(true);
        }
        // The same word elsewhere is a firm's.
        for (const domain of [
            'proton.com',
            'proton.energy',
            'pm.gc.ca',
            'pm.bet',
            'mail.schwarz',
            'live.events',
            'hey.agency',
        ]) {
            expect(isFreeMailDomain(domain), domain).toBe(false);
        }
        expect(companyDomainOfAddress('dana@proton.energy')).toBe('proton.energy');
    });

    it('knows the consumer mailboxes a provider hands out, by their exact domain', () => {
        for (const domain of ['comcast.net', 'verizon.net', 'btinternet.com', 'qq.com', '163.com', 'naver.com']) {
            expect(isFreeMailDomain(domain), domain).toBe(true);
        }
        // A service's relay addresses are its customers', not one company's.
        for (const domain of ['intercom-mail.com', 'hubspotemail.net', 'onmicrosoft.com', 'email4pr.com']) {
            expect(isFreeMailDomain(domain), domain).toBe(true);
        }
        // The provider's own staff write from another domain: that one is a company's.
        for (const domain of ['verizon.com', 'comcast.com', 'att.com', 'cox.com']) {
            expect(isFreeMailDomain(domain), domain).toBe(false);
        }
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

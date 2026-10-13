import { describe, expect, it } from 'vitest';
import { ValidationFailed } from '../infra/errors/api-errors';
import { exclusionTarget } from './exclusions.service';

describe('FR-CRMS-10 / #180: an exclusion targets exactly one address or domain, by the one email rule', () => {
    it('normalises an address and takes no domain', () => {
        expect(exclusionTarget({ address: '  Joe@Acme.COM ' })).toEqual({ address: 'joe@acme.com', domain: null });
    });

    it('takes a domain alone, lower-cased', () => {
        expect(exclusionTarget({ domain: ' Acme.com ' })).toEqual({ address: null, domain: 'acme.com' });
    });

    it('refuses an address the email rule does not accept, at "address", instead of reaching the database', () => {
        expect(() => exclusionTarget({ address: 'joe@acme_corp.com' })).toThrow(ValidationFailed);
    });

    it('refuses both, and refuses neither', () => {
        expect(() => exclusionTarget({ address: 'joe@acme.com', domain: 'acme.com' })).toThrow(ValidationFailed);
        expect(() => exclusionTarget({})).toThrow(ValidationFailed);
    });
});

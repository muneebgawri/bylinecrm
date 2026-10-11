import { describe, expect, it } from 'vitest';
import { maskAddress } from './unsubscribe.service';

describe('FR-CRMS-7 the address an unsubscribe page shows', () => {
    it('keeps the first character and the domain, and nothing else of the local part', () => {
        expect(maskAddress('dana.reyes@acme.example')).toBe('d•••@acme.example');
        expect(maskAddress('d@acme.example')).toBe('d•••@acme.example');
    });
});

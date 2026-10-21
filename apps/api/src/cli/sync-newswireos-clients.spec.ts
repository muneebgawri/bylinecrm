import { describe, expect, it } from 'vitest';
import { parseClients } from './sync-newswireos-clients';

describe('sync-newswireos-clients: the CSV of NewswireOS clients', () => {
    it('reads `email,account manager` lines: lower-cased, first account manager wins, junk skipped', () => {
        const clients = parseClients(
            'Ana@Acme.com, Kate  Uzzi\r\nbob@beta.io,\nana@acme.com,Someone Else\nnot an address,Kate\n\nzed@zeta.co',
        );
        expect([...clients]).toEqual([
            ['ana@acme.com', 'Kate Uzzi'],
            ['bob@beta.io', null],
            ['zed@zeta.co', null],
        ]);
    });
});

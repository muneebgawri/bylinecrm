import { describe, expect, it } from 'vitest';
import { parseClientIds, parseClients } from './sync-newswireos-clients';

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

    it('INV-2: an optional last field is the client id, kept out of the account manager’s name', () => {
        const text = [
            'ana@acme.com,Kate Uzzi,01a186a5-cfa7-706b-b6e2-28ecee96d39c',
            'bob@beta.io,"Smith, Jo",4213',
            'cy@gamma.io,Kate Uzzi',
            'dee@delta.io,,77',
            'ana@acme.com,Someone Else,dd28e73b-7331-486a-8883-7a9c8594afa3',
            'eve@eps.io,Not, An Id',
        ].join('\n');
        expect([...parseClients(text)]).toEqual([
            ['ana@acme.com', 'Kate Uzzi'],
            ['bob@beta.io', '"Smith, Jo"'],
            ['cy@gamma.io', 'Kate Uzzi'],
            ['dee@delta.io', null],
            ['eve@eps.io', 'Not, An Id'],
        ]);
        expect([...parseClientIds(text)]).toEqual([
            ['ana@acme.com', '01a186a5-cfa7-706b-b6e2-28ecee96d39c'],
            ['bob@beta.io', '4213'],
            ['dee@delta.io', '77'],
        ]);
    });
});

import { describe, expect, it } from 'vitest';
import { chooseOwner, combined, emailsOf, groupDuplicates, type MergeablePerson } from './merge-people';

const at = (day: number) => new Date(Date.UTC(2026, 9, day));
const person = (
    id: string,
    day: number,
    first: string,
    last: string,
    emails: string[],
    companyId: string | null = null,
) => ({
    id,
    nameFirst: first,
    nameLast: last,
    emails: { primary: emails[0] ?? null, additional: emails.slice(1) },
    companyId,
    createdAt: at(day),
});

describe('groupDuplicates', () => {
    it('auto: any shared address, primary or additional, case and spaces ignored, transitively', () => {
        const groups = groupDuplicates([
            person('c', 3, 'Rick', 'Hoganson', ['rick@acme.test']),
            person('a', 1, 'Rick', 'Hoganson', [' Rick@ACME.test ', 'r.h@gmail.com']),
            person('b', 2, 'R', 'Hoganson', ['other@x.test', 'r.h@gmail.com']),
            person('z', 4, 'Someone', 'Else', ['z@acme.test']),
        ]);
        expect(groups).toEqual([expect.objectContaining({ tier: 'auto', personIds: ['a', 'b', 'c'] })]);
    });

    it('review: same full name and the same company or work domain, never free mail or a single name', () => {
        const groups = groupDuplicates([
            person('a', 1, 'Rick', 'Hoganson', ['rick@acme.test']),
            person('b', 2, 'rick', 'hoganson', ['rhoganson@acme.test']),
            person('c', 3, 'Rick', 'Hoganson', ['rick@gmail.com']),
            person('d', 4, 'Rick', 'Hoganson', ['rick2@gmail.com']),
            person('e', 5, 'Ana', '', ['ana@co.test'], 'co'),
            person('f', 6, 'Ana', '', ['ana2@co2.test'], 'co'),
            person('g', 7, 'José', 'Núñez', ['j@one.test'], 'k'),
            person('h', 8, 'Jose', 'Nunez', ['jn@two.test'], 'k'),
        ]);
        expect(groups.map((g) => [g.tier, g.personIds])).toEqual([
            ['review', ['a', 'b']],
            ['review', ['g', 'h']],
        ]);
    });

    it('a review group takes in the auto groups it joins', () => {
        const groups = groupDuplicates([
            person('a', 1, 'Rick', 'Hoganson', ['rick@acme.test'], 'acme'),
            person('b', 2, 'Rick', 'Hoganson', ['rick@acme.test'.toUpperCase()]),
            person('c', 3, 'Rick', 'Hoganson', ['rh@other.test'], 'acme'),
        ]);
        expect(groups.map((g) => [g.tier, g.personIds])).toEqual([
            ['auto', ['a', 'b']],
            ['review', ['a', 'b', 'c']],
        ]);
    });
});

describe('chooseOwner', () => {
    const members = new Set(['m1', 'm2', 'm3']);
    const people = [
        { id: 'p1', createdAt: at(1), ownerId: 'm1', createdBy: { kind: 'import', id: 'run' } },
        { id: 'p2', createdAt: at(2), ownerId: 'm2', createdBy: { kind: 'member', id: 'm2' } },
        { id: 'p3', createdAt: at(3), ownerId: 'm2', createdBy: { kind: 'member', id: 'm3' } },
    ];

    it('the member who first contacted any duplicate owns it; their oldest record survives', () => {
        const d = chooseOwner(
            people,
            [
                { memberId: 'm1', at: at(9), how: 'email', personId: 'p1' },
                { memberId: 'm2', at: at(5), how: 'note', personId: 'p3' },
                { memberId: 'gone', at: at(4), how: 'email', personId: 'p1' },
            ],
            members,
        );
        expect(d).toMatchObject({ ownerId: 'm2', survivorId: 'p2' });
        expect(d.why).toContain('first contact: note');
    });

    it('a contacting member with no record of their own keeps the oldest record', () => {
        expect(
            chooseOwner(people, [{ memberId: 'm3', at: at(5), how: 'sequence', personId: 'p1' }], members),
        ).toMatchObject({
            ownerId: 'm3',
            survivorId: 'p1',
        });
    });

    it('no contact: the earliest-saved duplicate’s creator when a member, else its owner', () => {
        expect(chooseOwner(people, [], members)).toMatchObject({ ownerId: 'm1', survivorId: 'p1' });
        const byMember = [{ ...people[0]!, createdBy: { kind: 'member', id: 'm3' } }, people[1]!];
        expect(chooseOwner(byMember, [], members)).toMatchObject({ ownerId: 'm3', survivorId: 'p1' });
    });

    it('nobody: the oldest survives, its owner unchanged', () => {
        const none = people.map((p) => ({ ...p, ownerId: null, createdBy: { kind: 'import', id: 'run' } }));
        expect(chooseOwner(none, [], members)).toMatchObject({ ownerId: null, survivorId: 'p1' });
    });
});

describe('combined', () => {
    const base: MergeablePerson = {
        id: 's',
        nameFirst: 'Rick',
        nameLast: '',
        emails: { primary: 'Rick@Acme.test', additional: ['a@x.test'] },
        phones: { primary: { number: '555 1', countryCode: 'US' }, additional: [] },
        links: { linkedin: null, x: null },
        jobTitle: 'CEO',
        source: null,
        country: null,
        city: '',
        avatarUrl: null,
        companyId: null,
        custom: { biginrecordid: 'zcrm_1', tier: 'a' },
    };
    const dup: MergeablePerson = {
        ...base,
        id: 'd',
        nameLast: 'Hoganson',
        emails: { primary: 'r.h@gmail.com', additional: ['A@x.test', 'rick@acme.test'] },
        phones: { primary: { number: '5551', countryCode: 'US' }, additional: [{ number: '777', countryCode: 'GB' }] },
        links: { linkedin: { url: 'https://linkedin.com/in/r', label: null }, x: null },
        jobTitle: 'Founder',
        source: 'Bigin',
        city: 'Austin',
        companyId: 'acme',
        custom: { biginrecordid: 'zcrm_2', extra: 1 },
    };

    it('keeps the survivor’s values, fills its blanks, keeps every address and phone once', () => {
        const c = combined(base, dup);
        expect(c.emails).toEqual({ primary: 'rick@acme.test', additional: ['a@x.test', 'r.h@gmail.com'] });
        expect(c.phones).toEqual({
            primary: base.phones && { number: '555 1', countryCode: 'US' },
            additional: [{ number: '777', countryCode: 'GB' }],
        });
        expect(c).toMatchObject({
            nameFirst: 'Rick',
            nameLast: 'Hoganson',
            jobTitle: 'CEO',
            source: 'Bigin',
            city: 'Austin',
            companyId: 'acme',
            custom: { biginrecordid: 'zcrm_1', tier: 'a', extra: 1 },
        });
        expect(c.links.linkedin?.url).toBe('https://linkedin.com/in/r');
    });

    it('takes the duplicate’s primary when the survivor has none', () => {
        const c = combined({ ...base, emails: { primary: null, additional: [] } }, dup);
        expect(c.emails.primary).toBe('r.h@gmail.com');
        expect(emailsOf(c.emails)).toEqual(['r.h@gmail.com', 'a@x.test', 'rick@acme.test']);
    });
});

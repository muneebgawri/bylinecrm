import { GOOGLE_CONTACTS_SCOPE, GOOGLE_OTHER_CONTACTS_SCOPE } from '@bylinecrm/shared';
import { describe, expect, it, vi } from 'vitest';
import type { RlsPrismaService } from '../infra/rls-prisma.service';
import { MailboxUnavailable, type MailboxTokens } from '../mail-accounts/mailbox-tokens.service';
import type { EnrichmentSubject } from './enricher.port';
import { GOOGLE_CONTACTS_NO_PICTURE, GoogleContactsEnricher, pictureFor } from './google-contacts';
import { GoogleContactsError, type ContactList, type GoogleContactMatch } from './google-contacts.port';

const subject = {
    workspaceId: 'ws',
    object: 'person',
    id: 'p1',
    person: { email: 'Ana@Example.com', country: null, ownerId: 'owner' },
} as EnrichmentSubject;

const photo = (url: string, extra: Partial<GoogleContactMatch['photos'][number]> = {}) => ({
    url,
    default: false,
    primary: true,
    ...extra,
});

interface Box {
    id: string;
    ownerMemberId: string;
    grantedScopes: string[];
}

function enricher(
    boxes: Box[],
    search: (token: string, list: ContactList, query: string) => Promise<GoogleContactMatch[]>,
    token: (id: string) => Promise<string> = (id) => Promise.resolve(`token-${id}`),
) {
    const rls = {
        withWorkspace: (_ws: string, work: (tx: unknown) => unknown) =>
            work({ mailbox: { findMany: () => Promise.resolve(boxes.map((b) => ({ ...b }))) } }),
    } as unknown as RlsPrismaService;
    const tokens = { getAccessToken: (_ws: string, id: string) => token(id) } as unknown as MailboxTokens;
    const google = { search: vi.fn(search) };
    return { source: new GoogleContactsEnricher(rls, tokens, google), google };
}

const both = [GOOGLE_CONTACTS_SCOPE, GOOGLE_OTHER_CONTACTS_SCOPE];

describe('Google Contacts (AVATAR-1)', () => {
    it("answers the owner's contact picture, sized, at rank 2 — above Gravatar", async () => {
        const { source, google } = enricher(
            [
                { id: 'other-box', ownerMemberId: 'someone', grantedScopes: both },
                { id: 'owner-box', ownerMemberId: 'owner', grantedScopes: both },
            ],
            (token, _list, query) =>
                Promise.resolve(
                    token === 'token-owner-box' && query
                        ? [
                              {
                                  emails: ['ana@example.com'],
                                  photos: [photo('https://lh3.googleusercontent.com/a/x=s100')],
                              },
                          ]
                        : [],
                ),
        );
        expect(await source.enrich(subject)).toEqual([
            { field: 'avatar_url', status: 'answered', value: 'https://lh3.googleusercontent.com/a/x=s256', rank: 2 },
        ]);
        // The owner's mailbox is asked first: warmed, then searched, and nothing else.
        expect(google.search.mock.calls.map((c) => [c[0], c[2]])).toEqual([
            ['token-owner-box', ''],
            ['token-owner-box', 'ana@example.com'],
        ]);
    });

    it('searches Gmail’s other contacts when the saved ones have no picture', async () => {
        const { source } = enricher([{ id: 'b', ownerMemberId: 'owner', grantedScopes: both }], (_t, list, query) =>
            Promise.resolve(
                list === 'other' && query ? [{ emails: ['ana@example.com'], photos: [photo('https://x/p')] }] : [],
            ),
        );
        expect(await source.enrich(subject)).toMatchObject([{ status: 'answered', value: 'https://x/p' }]);
    });

    it('only searches the lists the grant carries', async () => {
        const { source, google } = enricher(
            [{ id: 'b', ownerMemberId: 'owner', grantedScopes: [GOOGLE_OTHER_CONTACTS_SCOPE] }],
            () => Promise.resolve([]),
        );
        await source.enrich(subject);
        expect(new Set(google.search.mock.calls.map((c) => c[1]))).toEqual(new Set(['other']));
    });

    it('no picture anywhere is a normal no answer', async () => {
        const { source } = enricher([{ id: 'b', ownerMemberId: 'owner', grantedScopes: both }], () =>
            Promise.resolve([]),
        );
        expect(await source.enrich(subject)).toEqual([
            { field: 'avatar_url', status: 'no_answer', note: GOOGLE_CONTACTS_NO_PICTURE },
        ]);
    });

    it('skips a mailbox that cannot be asked (needs reconnecting, API off) and asks the next', async () => {
        const { source } = enricher(
            [
                { id: 'gone', ownerMemberId: 'owner', grantedScopes: both },
                { id: 'off', ownerMemberId: 'x', grantedScopes: both },
                { id: 'ok', ownerMemberId: 'y', grantedScopes: both },
            ],
            (token, _l, query) => {
                if (token === 'token-off')
                    return Promise.reject(new GoogleContactsError(403, 'SERVICE_DISABLED', 'off'));
                return Promise.resolve(query ? [{ emails: ['ana@example.com'], photos: [photo('https://x/ok')] }] : []);
            },
            (id) =>
                id === 'gone'
                    ? Promise.reject(new MailboxUnavailable('reconnect_needed'))
                    : Promise.resolve(`token-${id}`),
        );
        expect(await source.enrich(subject)).toMatchObject([{ status: 'answered', value: 'https://x/ok' }]);
    });

    it('a throttled or unreachable Google with no picture found fails, so it is asked again', async () => {
        const { source } = enricher([{ id: 'b', ownerMemberId: 'owner', grantedScopes: both }], () =>
            Promise.reject(new GoogleContactsError(429, 'RESOURCE_EXHAUSTED', 'slow down')),
        );
        await expect(source.enrich(subject)).rejects.toBeInstanceOf(GoogleContactsError);
    });

    it('is available only where some mailbox may read contacts', async () => {
        expect(await enricher([], () => Promise.resolve([])).source.available('ws')).toBe(false);
        const box = { id: 'b', ownerMemberId: 'o', grantedScopes: both };
        expect(await enricher([box], () => Promise.resolve([])).source.available('ws')).toBe(true);
    });
});

describe('pictureFor', () => {
    it('takes only an exact address match and never a generated letter picture', () => {
        expect(
            pictureFor(
                [
                    { emails: ['ana@example.com.au'], photos: [photo('https://x/wrong')] },
                    { emails: ['ANA@example.com'], photos: [photo('https://x/letter', { default: true })] },
                ],
                'ana@example.com',
            ),
        ).toBeNull();
    });

    it('prefers the primary real picture', () => {
        expect(
            pictureFor(
                [
                    {
                        emails: ['ana@example.com'],
                        photos: [photo('https://x/second', { primary: false }), photo('https://x/first')],
                    },
                ],
                'ana@example.com',
            ),
        ).toBe('https://x/first');
    });
});

import {
    SIGNATURE_STARTER,
    type Capability,
    type MailboxSignatureView,
    type RichText,
    type SignatureProfileView,
    type SignatureSettingsView,
} from '@bylinecrm/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mailbox, mailboxesRoute } from '../mail/mailTestKit';
import { json, renderAt, route, stubApi, type FakeRequest, type FakeRoute } from './settingsTestKit';
import { Signatures } from './Signatures';

const UNLOCKED = { logo: false, bookingLink: false };
const SETTINGS: SignatureSettingsView = {
    defaultSignature: null,
    locked: UNLOCKED,
    logo: null,
    starter: SIGNATURE_STARTER,
};
const PROFILE: SignatureProfileView = {
    memberId: 'm-1',
    name: 'Kate Morgan',
    jobTitle: null,
    phone: null,
    slotlineUsername: null,
    bookingLink: null,
    slotlineConfigured: true,
    slotlineKey: null,
    slotlineEvent: null,
};
const NONE: MailboxSignatureView = {
    mailboxId: 'mb-1',
    own: null,
    useDefault: true,
    applies: 'none',
    effective: null,
    bookingLink: null,
    locked: UNLOCKED,
};
const fromGmail: RichText = {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Kate from Gmail' }] }],
};

const MEMBER: Capability[] = ['record:read', 'mailbox:read'];
const ADMIN: Capability[] = ['record:read', 'mailbox:read', 'mailbox:manage', 'workspace:admin'];

const reads: FakeRoute[] = [
    mailboxesRoute([mailbox({ id: 'mb-1', email: 'kate@example.com' })]),
    (r) => (r.method === 'GET' && r.url.endsWith('/settings/signatures') ? json(SETTINGS) : undefined),
    (r) => (r.method === 'GET' && r.url.endsWith('/members/m-1/signature-profile') ? json(PROFILE) : undefined),
    (r) => (r.method === 'GET' && r.url.endsWith('/members/signature-profiles') ? json([PROFILE]) : undefined),
    (r) => (r.method === 'GET' && r.url.endsWith('/mailboxes/mb-1/signature') ? json(NONE) : undefined),
];

function open(routes: FakeRoute[], capabilities = MEMBER): FakeRequest[] {
    const seen = stubApi([...routes, ...reads]);
    renderAt(
        [route('/w/:workspaceId/settings/signatures', <Signatures />)],
        '/w/ws-1/settings/signatures',
        capabilities,
    );
    return seen;
}

describe('#193 Settings → Signatures', { timeout: 20_000 }, () => {
    afterEach(() => vi.unstubAllGlobals());

    it('a member sets their title, phone and Slotline username, and sees the booking link it makes', async () => {
        const seen = open([
            (r) =>
                r.method === 'PUT' && r.url.endsWith('/members/m-1/signature-profile')
                    ? json({ ...PROFILE, ...(r.body as object), bookingLink: 'https://bookings.example.com/kate' })
                    : undefined,
        ]);
        await userEvent.type(await screen.findByLabelText('Job title'), 'Account manager');
        await userEvent.type(screen.getByLabelText('Phone'), '+92 300 1234567');
        await userEvent.type(screen.getByLabelText('Slotline username'), 'kate');
        await userEvent.click(screen.getByRole('button', { name: 'Save details' }));
        await waitFor(() =>
            expect(seen.find((r) => r.method === 'PUT')?.body).toEqual({
                jobTitle: 'Account manager',
                phone: '+92 300 1234567',
                slotlineUsername: 'kate',
            }),
        );
        expect(await screen.findByRole('link', { name: 'https://bookings.example.com/kate' })).toBeInTheDocument();
    });

    it('a mailbox’s own signature starts with the logo and the booking link pre-filled', async () => {
        const seen = open([
            (r) =>
                r.method === 'PUT' && r.url.endsWith('/mailboxes/mb-1/signature')
                    ? json({ ...NONE, own: SIGNATURE_STARTER, applies: 'own', effective: SIGNATURE_STARTER })
                    : undefined,
        ]);
        const card = await screen.findByRole('region', { name: 'kate@example.com' });
        expect(await within(card).findByText('No signature')).toBeInTheDocument();
        await userEvent.click(within(card).getByRole('button', { name: 'Write its own signature' }));
        const editor = within(card).getByRole('textbox', { name: 'Signature for kate@example.com' });
        expect(within(editor).getByLabelText('Variable workspace.logo')).toBeInTheDocument();
        expect(within(editor).getByLabelText('Variable sender.bookingLink')).toBeInTheDocument();
        await userEvent.click(within(card).getByRole('button', { name: 'Save signature' }));
        await waitFor(() =>
            expect(seen.find((r) => r.method === 'PUT')?.body).toEqual({ own: SIGNATURE_STARTER, useDefault: true }),
        );
    });

    it('imports the Gmail signature into the editor, to save or not', async () => {
        const seen = open([
            (r) =>
                r.method === 'POST' && r.url.endsWith('/mailboxes/mb-1/signature/import')
                    ? json({ signature: fromGmail, droppedImages: 1 })
                    : undefined,
        ]);
        const card = await screen.findByRole('region', { name: 'kate@example.com' });
        await userEvent.click(await within(card).findByRole('button', { name: 'Import from Gmail' }));
        const editor = await within(card).findByRole('textbox', { name: 'Signature for kate@example.com' });
        await waitFor(() => expect(editor).toHaveTextContent('Kate from Gmail'));
        expect(within(card).getByText('1 image not on https was left out.')).toBeInTheDocument();
        expect(seen.some((r) => r.method === 'PUT')).toBe(false);
    });

    it('an admin also sets the logo, the workspace signature and its locks; a member sees none of that', async () => {
        open([]);
        expect(await screen.findByRole('region', { name: 'kate@example.com' })).toBeInTheDocument();
        expect(screen.queryByRole('region', { name: 'Company logo' })).not.toBeInTheDocument();
        expect(screen.queryByRole('region', { name: 'Workspace signature' })).not.toBeInTheDocument();
        vi.unstubAllGlobals();
        document.body.innerHTML = '';

        const seen = open(
            [
                (r) =>
                    r.method === 'PUT' && r.url.endsWith('/settings/signatures')
                        ? json({ ...SETTINGS, ...(r.body as object) })
                        : undefined,
            ],
            ADMIN,
        );
        const logo = await screen.findByRole('region', { name: 'Company logo' });
        expect(within(logo).getByLabelText(/Upload a logo/)).toBeInTheDocument();
        const workspace = screen.getByRole('region', { name: 'Workspace signature' });
        await userEvent.click(within(workspace).getByRole('button', { name: 'Set a workspace signature' }));
        await userEvent.click(within(workspace).getByRole('checkbox', { name: 'Lock the logo' }));
        await userEvent.click(within(workspace).getByRole('button', { name: 'Save workspace signature' }));
        await waitFor(() =>
            expect(seen.find((r) => r.method === 'PUT' && r.url.endsWith('/settings/signatures'))?.body).toEqual({
                defaultSignature: SIGNATURE_STARTER,
                locked: { logo: true, bookingLink: false },
            }),
        );
    });

    it('an admin sets another member’s details — their Slotline username — from the members list', async () => {
        const sam: SignatureProfileView = { ...PROFILE, memberId: 'm-2', name: 'Sam Okafor', jobTitle: 'Partner' };
        const seen = open(
            [
                (r) =>
                    r.method === 'GET' && r.url.endsWith('/members/signature-profiles')
                        ? json([PROFILE, sam])
                        : undefined,
                (r) =>
                    r.method === 'PUT' && r.url.endsWith('/members/m-2/signature-profile')
                        ? json({ ...sam, ...(r.body as object), bookingLink: 'https://bookings.example.com/sam' })
                        : undefined,
            ],
            ADMIN,
        );
        const list = await screen.findByRole('region', { name: 'Members’ details' });
        const edit = await within(list).findByRole('button', { name: 'Edit Sam Okafor’s details' });
        // The admin's own details are above, not repeated here.
        expect(within(list).queryByText('Kate Morgan')).not.toBeInTheDocument();
        await userEvent.click(edit);
        await userEvent.type(within(list).getByLabelText('Slotline username'), 'sam');
        await userEvent.click(within(list).getByRole('button', { name: 'Save details' }));
        await waitFor(() =>
            expect(seen.find((r) => r.method === 'PUT')?.body).toEqual({
                jobTitle: 'Partner',
                phone: null,
                slotlineUsername: 'sam',
            }),
        );
    });

    it('a member sees no one else’s details', async () => {
        const seen = open([]);
        await screen.findByRole('region', { name: 'kate@example.com' });
        expect(screen.queryByRole('region', { name: 'Members’ details' })).not.toBeInTheDocument();
        expect(seen.some((r) => r.url.endsWith('/members/signature-profiles'))).toBe(false);
    });

    describe('#196 a Slotline event type for the booking link', () => {
        const KEYED: SignatureProfileView = {
            ...PROFILE,
            slotlineUsername: 'kate',
            slotlineKey: { last4: 'k3y9' },
            bookingLink: 'https://bookings.example.com/kate',
        };

        it('connects the member’s Slotline account with their API key, shown by its last four after', async () => {
            const seen = open([
                (r) => (r.method === 'PUT' && r.url.endsWith('/members/m-1/slotline-key') ? json(KEYED) : undefined),
            ]);
            await userEvent.type(await screen.findByLabelText('Slotline API key'), 'cal_live_abc_k3y9');
            await userEvent.click(screen.getByRole('button', { name: 'Connect Slotline account' }));
            await waitFor(() =>
                expect(seen.find((r) => r.url.endsWith('/slotline-key'))?.body).toEqual({
                    apiKey: 'cal_live_abc_k3y9',
                }),
            );
            expect(await screen.findByText(/Key ending k3y9/)).toBeInTheDocument();
            expect(screen.queryByLabelText('Slotline API key')).not.toBeInTheDocument();
        });

        it('offers every event type on the account, hidden ones marked, and saves the pick', async () => {
            const seen = open([
                (r) =>
                    r.method === 'GET' && r.url.endsWith('/members/m-1/signature-profile') ? json(KEYED) : undefined,
                (r) =>
                    r.method === 'GET' && r.url.endsWith('/members/m-1/slotline/event-types')
                        ? json([
                              {
                                  slug: 'intro',
                                  title: 'Intro call',
                                  lengthInMinutes: 30,
                                  hidden: false,
                                  bookingLink: 'https://bookings.example.com/kate/intro',
                              },
                              {
                                  slug: 'vip-15',
                                  title: 'VIP 15',
                                  lengthInMinutes: 15,
                                  hidden: true,
                                  bookingLink: 'https://bookings.example.com/kate/vip-15',
                              },
                          ])
                        : undefined,
                (r) =>
                    r.method === 'PUT' && r.url.endsWith('/members/m-1/slotline-event')
                        ? json({ ...KEYED, slotlineEvent: { slug: 'vip-15', title: 'VIP 15' } })
                        : undefined,
            ]);
            await userEvent.click(await screen.findByRole('combobox', { name: 'Book a quick meeting opens' }));
            const options = (await screen.findAllByRole('option')).map((o) => o.textContent);
            expect(options).toEqual(['Your Slotline page', 'Intro call · 30 min', 'VIP 15 · 15 min · hidden']);
            await userEvent.click(screen.getByRole('option', { name: 'VIP 15 · 15 min · hidden' }));
            await waitFor(() =>
                expect(seen.find((r) => r.url.endsWith('/slotline-event'))?.body).toEqual({ slug: 'vip-15' }),
            );
        });
    });
});

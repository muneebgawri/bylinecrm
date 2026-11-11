import type { Capability } from '@bylinecrm/shared';
import { toasts } from '@bylinecrm/ui';
import { Toaster } from '@bylinecrm/ui/toaster';
import { configure, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BlocklistEntryView, GoogleOAuthClientStatusView, MailboxSyncView, MailboxView } from '../../../api/types';
import { json, renderAt, route, stubApi, type FakeRoute } from '../settings/settingsTestKit';
import { MailboxesPage } from './MailboxesPage';

const leaveFor = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/leaveFor', () => ({ leaveFor }));

const WS = 'ws-1';
const AUTHORIZE = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x&state=y';

const mailbox = (over: Partial<MailboxView>): MailboxView => ({
    id: 'mb-1',
    ownerMemberId: 'm-1',
    email: 'kate@example.com',
    label: null,
    purpose: 'personal',
    transport: 'gmail',
    credentialSource: 'oauth',
    status: 'connected',
    grantedScopes: [],
    lastError: null,
    connectedAt: '2026-10-09T08:00:00.000Z',
    createdAt: '2026-10-09T08:00:00.000Z',
    updatedAt: '2026-10-09T08:00:00.000Z',
    ...over,
});

const MAILBOXES: MailboxView[] = [
    mailbox({}),
    mailbox({
        id: 'mb-2',
        ownerMemberId: 'm-2',
        email: 'outreach@example.com',
        purpose: 'pool',
        status: 'reconnect_needed',
        connectedAt: '2026-10-08T08:00:00.000Z',
        lastError: { code: 'invalid_grant', message: 'Google revoked access', at: '2026-10-09T07:00:00.000Z' },
    }),
];

const sync = (mailboxId: string, over: Partial<MailboxSyncView> = {}): MailboxSyncView => ({
    mailboxId,
    status: 'idle',
    lastSyncedAt: '2026-10-09T08:55:00.000Z',
    fullSyncCompletedAt: '2026-10-09T08:10:00.000Z',
    lastError: null,
    ...over,
});

const configured: GoogleOAuthClientStatusView = {
    configured: true,
    verified: true,
    redirectUri: 'https://crm.example.com/api/mail/oauth/callback',
    scopes: [],
};

function api(extra: FakeRoute[] = [], blocklist: BlocklistEntryView[] = []) {
    return stubApi([
        ...extra,
        (r) => (r.url.endsWith('/mail/oauth-client/status') ? json(configured) : undefined),
        (r) => {
            const m = r.method === 'GET' && r.url.match(/\/mailboxes\/([^/]+)\/sync$/);
            return m ? json(sync(m[1] ?? '')) : undefined;
        },
        (r) => (r.method === 'GET' && r.url.endsWith('/mailboxes') ? json(MAILBOXES) : undefined),
        (r) => (r.method === 'GET' && r.url.endsWith('/mail/blocklist') ? json(blocklist) : undefined),
        (r) => (r.method === 'GET' && r.url.endsWith('/mail/history-backfill') ? json(history()) : undefined),
        (r) =>
            r.url.endsWith('/members/summary')
                ? json([
                      { memberId: 'm-1', name: 'Kate Morgan' },
                      { memberId: 'm-2', name: 'Sam Okafor' },
                  ])
                : undefined,
    ]);
}

const history = (status: 'running' | null = null) => ({
    floor: '2023-04-01',
    usedBytes: 0,
    maxBytes: 4 * 1024 ** 3,
    mailboxes: [
        {
            mailboxId: 'mb-1',
            email: 'kate@example.com',
            status,
            floor: status ? '2023-04-01T00:00:00.000Z' : null,
            reachedBack: null,
            completedAt: null,
            imported: 0,
            listed: 0,
            unmatched: 0,
        },
    ],
});

const ALL: Capability[] = ['mailbox:read', 'mailbox:manage', 'workspace:admin', 'record:read'];

const page = (search = '', capabilities: Capability[] = ALL) =>
    renderAt(
        [
            route(
                '/w/:workspaceId/mailboxes',
                <>
                    <MailboxesPage />
                    <Toaster />
                </>,
            ),
        ],
        `/w/${WS}/mailboxes${search}`,
        capabilities,
    );

describe('FR-CRMS-1: connecting a Google mailbox', () => {
    beforeEach(() => leaveFor.mockReset());
    afterEach(() => {
        vi.unstubAllGlobals();
        toasts.clear();
    });

    it('asks what the mailbox is for, says it cannot change, then sends the browser to Google', async () => {
        const seen = api([
            (r) =>
                r.method === 'POST' && r.url.endsWith('/mailboxes/connect')
                    ? json({ authorizeUrl: AUTHORIZE, expiresAt: '2026-10-09T09:10:00.000Z' }, 201)
                    : undefined,
        ]);
        page();
        await userEvent.click(await screen.findByRole('button', { name: 'Connect mailbox' }));
        const dialog = await screen.findByRole('dialog');
        expect(within(dialog).getByText(/can’t change this later/)).toBeInTheDocument();
        await userEvent.click(within(dialog).getByRole('radio', { name: /Shared outreach mailbox/ }));
        await userEvent.click(within(dialog).getByRole('button', { name: 'Continue to Google' }));
        await waitFor(() => expect(leaveFor).toHaveBeenCalledWith(AUTHORIZE));
        expect(seen.find((r) => r.url.endsWith('/mailboxes/connect'))?.body).toEqual({ purpose: 'pool' });
    });

    it('opens the connect sheet from ?create=1 (the palette’s "Connect a mailbox")', async () => {
        api();
        page('?create=1');
        expect(await screen.findByRole('dialog', { name: 'Connect a mailbox' })).toBeInTheDocument();
    });

    it('says what went wrong and what to do when Google granted full mailbox access', async () => {
        api();
        page('?connect=scope_too_broad');
        expect(await screen.findByText('Full mailbox access was granted')).toBeInTheDocument();
        expect(screen.getByText(/mail\.google\.com/)).toBeInTheDocument();
    });

    it('announces the result once, even when effects run twice (the app renders in StrictMode)', async () => {
        configure({ reactStrictMode: true });
        try {
            api();
            page('?connect=denied');
            expect(await screen.findByText('Google access was declined')).toBeInTheDocument();
            await new Promise((resolve) => setTimeout(resolve, 50));
            expect(screen.getAllByText('Google access was declined')).toHaveLength(1);
        } finally {
            configure({ reactStrictMode: false });
        }
    });

    it('confirms a connect and marks the mailbox that just connected', async () => {
        api();
        page('?connect=connected');
        expect(await screen.findByText('Mailbox connected')).toBeInTheDocument();
        // Kate's mailbox is listed twice — in the mailboxes and in the mail history; its mailbox row is the one marked.
        await waitFor(() => {
            const rows = screen.getAllByText('kate@example.com').map((cell) => cell.closest('tr'));
            expect(rows.some((row) => row && within(row).queryByText('Just connected'))).toBe(true);
        });
    });

    it('#129 says Postmaster Tools connected when that is what the callback finished, and marks no mailbox', async () => {
        api();
        page('?connect=connected&for=postmaster');
        expect(await screen.findByText('Postmaster Tools connected')).toBeInTheDocument();
        expect(screen.queryByText('Mailbox connected')).not.toBeInTheDocument();
        await screen.findAllByText('kate@example.com');
        expect(screen.queryByText('Just connected')).not.toBeInTheDocument();
    });
});

describe('FR-CRMS-1, FR-CRMS-2: each mailbox shows where it stands and its sync', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        toasts.clear();
    });

    it('shows status with its reason, purpose, owner and the last sync — and no sending-health numbers', async () => {
        api();
        page();
        expect(await screen.findByText('outreach@example.com')).toBeInTheDocument();
        expect(screen.getByText('Reconnect needed')).toBeInTheDocument();
        expect(screen.getByText(/Google revoked access/)).toBeInTheDocument();
        // Your own mailbox reads "You"; another member's names its owner.
        expect(screen.getByText('You')).toBeInTheDocument();
        expect(screen.getByText('Sam Okafor')).toBeInTheDocument();
        expect(screen.getByText('Shared outreach')).toBeInTheDocument();
        expect(await screen.findAllByText(/^Synced /)).not.toHaveLength(0);
        // The sending pool is outreach's: without `outreach:write` it is not drawn (P3-2).
        expect(screen.queryByRole('heading', { name: 'Sending pool' })).not.toBeInTheDocument();
    });

    it('disconnects only after the page’s own confirmation', async () => {
        const seen = api([
            (r) =>
                r.method === 'DELETE' && r.url.endsWith('/mailboxes/mb-1')
                    ? json({ mailbox: mailbox({ status: 'disconnected' }), revoked: true })
                    : undefined,
        ]);
        page();
        await userEvent.click(await screen.findByRole('button', { name: 'Actions for kate@example.com' }));
        await userEvent.click(await screen.findByRole('menuitem', { name: 'Disconnect' }));
        const dialog = await screen.findByRole('dialog');
        expect(seen.some((r) => r.method === 'DELETE')).toBe(false);
        await userEvent.click(within(dialog).getByRole('button', { name: 'Disconnect' }));
        await waitFor(() => expect(seen.some((r) => r.method === 'DELETE')).toBe(true));
    });
});

describe('#144: who a shared outreach mailbox sends as', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        toasts.clear();
    });

    it('an admin hands a pool mailbox to the member it belongs to', async () => {
        const seen = api([
            (r) =>
                r.method === 'PATCH' && r.url.endsWith('/mailboxes/mb-2')
                    ? json(
                          mailbox({ id: 'mb-2', ownerMemberId: 'm-1', email: 'outreach@example.com', purpose: 'pool' }),
                      )
                    : undefined,
        ]);
        page();
        await userEvent.click(await screen.findByRole('button', { name: 'Actions for outreach@example.com' }));
        await userEvent.click(await screen.findByRole('menuitem', { name: 'Choose who it sends as' }));
        const dialog = await screen.findByRole('dialog');
        await userEvent.click(within(dialog).getByRole('combobox', { name: 'Sends as' }));
        await userEvent.click(await screen.findByRole('option', { name: 'Kate Morgan' }));
        await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
        await waitFor(() => expect(seen.find((r) => r.method === 'PATCH')?.body).toEqual({ ownerMemberId: 'm-1' }));
    });

    it('is not offered for a personal mailbox', async () => {
        api();
        page();
        await userEvent.click(await screen.findByRole('button', { name: 'Actions for kate@example.com' }));
        expect(await screen.findByRole('menuitem', { name: 'Disconnect' })).toBeInTheDocument();
        expect(screen.queryByRole('menuitem', { name: 'Choose who it sends as' })).not.toBeInTheDocument();
    });
});

describe('FR-CRMS-2: the blocklist removes mail it covers', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        toasts.clear();
    });

    it('adds an entry and says how much stored mail it removed', async () => {
        const seen = api([
            (r) =>
                r.method === 'POST' && r.url.endsWith('/mail/blocklist')
                    ? json(
                          {
                              entry: {
                                  id: 'b-1',
                                  value: '@spam.example',
                                  scope: 'personal',
                                  createdAt: '2026-10-09T09:00:00.000Z',
                              },
                              purged: { messages: 12, threads: 4 },
                          },
                          201,
                      )
                    : undefined,
        ]);
        page();
        await userEvent.click(await screen.findByRole('button', { name: 'Block an address' }));
        const dialog = await screen.findByRole('dialog');
        await userEvent.type(within(dialog).getByLabelText(/^Address or domain/), '@Spam.example');
        await userEvent.click(within(dialog).getByRole('button', { name: 'Block' }));
        await waitFor(() => expect(seen.some((r) => r.method === 'POST')).toBe(true));
        expect(seen.find((r) => r.method === 'POST')?.body).toEqual({ value: '@spam.example', scope: 'personal' });
        expect(await screen.findByText('Removed 12 messages from 4 threads.')).toBeInTheDocument();
    });

    it('refuses something that is neither an address nor a domain before sending it', async () => {
        const seen = api();
        page();
        await userEvent.click(await screen.findByRole('button', { name: 'Block an address' }));
        const dialog = await screen.findByRole('dialog');
        await userEvent.type(within(dialog).getByLabelText(/^Address or domain/), 'not an address');
        await userEvent.click(within(dialog).getByRole('button', { name: 'Block' }));
        expect(await within(dialog).findByText(/an address like someone@example.com/)).toBeInTheDocument();
        expect(seen.some((r) => r.method === 'POST')).toBe(false);
    });
});

describe('mail history: an admin brings older Gmail mail onto the records', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        toasts.clear();
    });

    it('starts the import after saying what it does, and shows each mailbox importing', async () => {
        const seen = api([
            (r) =>
                r.method === 'POST' && r.url.endsWith('/mail/history-backfill')
                    ? json(history('running'), 202)
                    : undefined,
        ]);
        page();
        const section = await screen.findByRole('region', { name: 'Mail history' });
        expect(await within(section).findByText('Not started')).toBeInTheDocument();
        await userEvent.click(within(section).getByRole('button', { name: 'Import mail since 1 Apr 2023' }));
        const dialog = await screen.findByRole('dialog');
        expect(within(dialog).getByText(/other mail is not stored/)).toBeInTheDocument();
        await userEvent.click(within(dialog).getByRole('button', { name: 'Start import' }));
        expect(await within(section).findByText('Importing')).toBeInTheDocument();
        expect(seen.some((r) => r.method === 'POST' && r.url.endsWith('/mail/history-backfill'))).toBe(true);
    });

    it('is not shown to a member who is not an admin', async () => {
        api();
        page('', ['mailbox:read', 'mailbox:manage', 'record:read']);
        expect(await screen.findByRole('heading', { name: 'Blocklist' })).toBeInTheDocument();
        expect(screen.queryByRole('region', { name: 'Mail history' })).toBeNull();
    });
});

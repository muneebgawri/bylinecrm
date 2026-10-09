import type { Capability } from '@bylinecrm/shared';
import { toasts } from '@bylinecrm/ui';
import { Toaster } from '@bylinecrm/ui/toaster';
import { screen, waitFor, within } from '@testing-library/react';
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
        (r) =>
            r.url.endsWith('/members/summary')
                ? json([
                      { memberId: 'm-1', name: 'Kate Morgan' },
                      { memberId: 'm-2', name: 'Sam Okafor' },
                  ])
                : undefined,
    ]);
}

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

    it('confirms a connect and marks the mailbox that just connected', async () => {
        api();
        page('?connect=connected');
        expect(await screen.findByText('Mailbox connected')).toBeInTheDocument();
        const row = (await screen.findAllByText('kate@example.com'))[0]?.closest('tr');
        expect(row && within(row).getByText('Just connected')).toBeTruthy();
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
        expect(screen.getByText(/arrives with outreach/)).toBeInTheDocument();
        expect(screen.queryByText(/Daily cap/i)).not.toBeInTheDocument();
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

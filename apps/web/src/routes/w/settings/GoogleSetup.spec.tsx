import { GMAIL_BROAD_SCOPE } from '@bylinecrm/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GoogleOAuthClientStatusView, GoogleOAuthClientView } from '../../../api/types';
import { GoogleSetup } from './GoogleSetup';
import { apiError, json, renderAt, route, stubApi } from './settingsTestKit';

const WS = 'ws-1';
const REDIRECT = 'https://crm.example.com/api/mail/oauth/callback';
const SCOPES = ['https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.readonly'];
const SECRET = 'GOCSPX-super-secret-value-1a2b';

const unconfigured: GoogleOAuthClientView = {
    configured: false,
    clientId: null,
    clientSecretLast4: null,
    redirectUri: REDIRECT,
    scopes: SCOPES,
    verifiedAt: null,
    lastCheck: null,
    liveMailboxes: 0,
    configuredBy: null,
    updatedAt: null,
};

const configured: GoogleOAuthClientView = {
    ...unconfigured,
    configured: true,
    clientId: '123456-abcdef.apps.googleusercontent.com',
    clientSecretLast4: '1a2b',
    configuredBy: 'm-1',
    updatedAt: '2026-10-09T09:00:00.000Z',
    liveMailboxes: 2,
};

const checked: GoogleOAuthClientView = {
    ...configured,
    lastCheck: {
        checkedAt: '2026-10-09T09:05:00.000Z',
        format: { outcome: 'pass', message: 'The client ID has the shape of a Google web client ID.' },
        credentials: { outcome: 'fail', message: 'Google does not know this client or refused its secret.' },
        redirectUri: { outcome: 'unverified', message: 'Google checks the redirect URI when someone signs in.' },
    },
};

const status = (s: Partial<GoogleOAuthClientStatusView>): GoogleOAuthClientStatusView => ({
    configured: false,
    verified: false,
    redirectUri: REDIRECT,
    scopes: SCOPES,
    ...s,
});

const page = (capabilities: Parameters<typeof renderAt>[2]) =>
    renderAt([route('/w/:workspaceId/settings/google', <GoogleSetup />)], `/w/${WS}/settings/google`, capabilities);

describe('FR-CRMS-1: an admin sets up the workspace’s own Google OAuth client (doc 50 §E)', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('shows the exact redirect URI and scope list the API reports, and warns off the broad scope', async () => {
        stubApi([(r) => (r.url.endsWith('/mail/oauth-client') ? json(unconfigured) : undefined)]);
        page(['workspace:admin', 'mailbox:read']);
        expect(await screen.findByText(REDIRECT)).toBeInTheDocument();
        for (const scope of SCOPES) expect(screen.getByText(scope)).toBeInTheDocument();
        expect(screen.getByText(/Internal/)).toBeInTheDocument();
        expect(screen.getByText(GMAIL_BROAD_SCOPE)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Copy redirect URI' })).toBeInTheDocument();
    });

    it('sends the client and never shows the secret again — only its last four characters', async () => {
        let saved = false;
        const seen = stubApi([
            (r) => {
                if (r.method === 'PUT') {
                    saved = true;
                    return json(configured);
                }
                return undefined;
            },
            (r) => (r.url.endsWith('/mail/oauth-client') ? json(saved ? configured : unconfigured) : undefined),
        ]);
        page(['workspace:admin', 'mailbox:read']);
        await userEvent.type(await screen.findByLabelText(/^Client ID/), '123456-abcdef.apps.googleusercontent.com');
        await userEvent.type(screen.getByLabelText(/^Client secret/), SECRET);
        await userEvent.click(screen.getByRole('button', { name: 'Save client' }));
        await waitFor(() => expect(seen.some((r) => r.method === 'PUT')).toBe(true));
        expect(seen.find((r) => r.method === 'PUT')?.body).toEqual({
            clientId: '123456-abcdef.apps.googleusercontent.com',
            clientSecret: SECRET,
        });
        expect(await screen.findByText('•••• 1a2b')).toBeInTheDocument();
        expect(screen.queryByDisplayValue(SECRET)).not.toBeInTheDocument();
        expect(document.body.textContent).not.toContain(SECRET);
    });

    it('shows each verification step’s outcome and says the redirect URI is proven by the first sign-in', async () => {
        const seen = stubApi([
            (r) => (r.method === 'POST' && r.url.endsWith('/verify') ? json(checked) : undefined),
            (r) => (r.url.endsWith('/mail/oauth-client') ? json(configured) : undefined),
        ]);
        page(['workspace:admin', 'mailbox:read']);
        await userEvent.click(await screen.findByRole('button', { name: 'Verify' }));
        await waitFor(() => expect(seen.some((r) => r.url.endsWith('/verify'))).toBe(true));
        const results = await screen.findByRole('list', { name: 'Verification results' });
        expect(within(results).getByText('Client ID format')).toBeInTheDocument();
        expect(within(results).getByText('Passed')).toBeInTheDocument();
        expect(within(results).getByText('Failed')).toBeInTheDocument();
        expect(within(results).getByText('Not yet confirmed')).toBeInTheDocument();
        expect(within(results).getByText(/refused its secret/)).toBeInTheDocument();
        expect(screen.getByText(/confirmed when the first mailbox connects/)).toBeInTheDocument();
    });

    it('shows the server’s refusal when the client still has connected mailboxes', async () => {
        stubApi([
            (r) =>
                r.method === 'DELETE'
                    ? apiError(409, 'conflict', '2 mailboxes are connected through this client; disconnect them first')
                    : undefined,
            (r) => (r.url.endsWith('/mail/oauth-client') ? json(configured) : undefined),
        ]);
        page(['workspace:admin', 'mailbox:read']);
        await userEvent.click(await screen.findByRole('button', { name: 'Remove client' }));
        const dialog = await screen.findByRole('dialog');
        await userEvent.click(within(dialog).getByRole('button', { name: 'Remove client' }));
        expect(await within(dialog).findByRole('alert')).toHaveTextContent('2 mailboxes are connected');
    });
});

describe('FR-CRMS-UI-6: a member who is not an admin sees whether Google is set up, read-only', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('says the admin has set it up, with no form, when the client is configured', async () => {
        const seen = stubApi([
            (r) => (r.url.endsWith('/mail/oauth-client/status') ? json(status({ configured: true })) : undefined),
        ]);
        page(['mailbox:read']);
        expect(await screen.findByText('Your admin has set up Google.')).toBeInTheDocument();
        expect(screen.queryByLabelText(/^Client secret/)).not.toBeInTheDocument();
        expect(seen.some((r) => r.url.endsWith('/mail/oauth-client'))).toBe(false);
    });

    it('says to ask an admin when the client is not configured', async () => {
        stubApi([(r) => (r.url.endsWith('/mail/oauth-client/status') ? json(status({})) : undefined)]);
        page(['mailbox:read']);
        expect(await screen.findByText('Google isn’t set up yet — ask an admin.')).toBeInTheDocument();
    });
});

import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Smtp2GoMailboxView } from '../../../api/types';
import { json, renderAt, route, stubApi } from './settingsTestKit';
import { Smtp2Go } from './Smtp2Go';

const added: Smtp2GoMailboxView = {
    mailbox: {
        id: 'mb-s2g',
        ownerMemberId: 'm-1',
        email: 'hello@outreach-mail.example',
        label: null,
        purpose: 'pool',
        transport: 'smtp2go',
        credentialSource: 'oauth',
        status: 'connected',
        grantedScopes: [],
        lastError: null,
        connectedAt: '2026-10-20T08:00:00.000Z',
        createdAt: '2026-10-20T08:00:00.000Z',
        updatedAt: '2026-10-20T08:00:00.000Z',
    },
    hookUrl: 'https://crm.example/api/hooks/smtp2go/mb-s2g',
    hookAuthorization: 'Bearer secret-value',
    lastHookAt: null,
    lastHookResult: null,
};

const open = () =>
    renderAt([route('/w/:workspaceId/settings/smtp2go', <Smtp2Go />)], '/w/ws-1/settings/smtp2go', ['workspace:admin']);

describe('TRANS-1 Settings → SMTP2Go', { timeout: 20_000 }, () => {
    afterEach(() => vi.unstubAllGlobals());

    it('checks the key before adding a pool mailbox, then shows its webhook and never the key', async () => {
        let current: Smtp2GoMailboxView[] = [];
        const seen = stubApi([
            (r) => (r.method === 'GET' && r.url.endsWith('/smtp2go/mailboxes') ? json(current) : undefined),
            (r) => {
                if (r.method !== 'POST' || !r.url.endsWith('/smtp2go/mailboxes')) return undefined;
                current = [added];
                return json(added, 201);
            },
        ]);
        open();
        await userEvent.type(await screen.findByLabelText(/Sending address/), 'hello@outreach-mail.example');
        await userEvent.type(screen.getByLabelText(/API key/), 'not-a-key');
        await userEvent.click(screen.getByRole('button', { name: 'Add mailbox' }));
        expect(await screen.findByText(/Enter an SMTP2Go API key/)).toBeInTheDocument();
        expect(seen.find((r) => r.method === 'POST')).toBeUndefined();

        await userEvent.clear(screen.getByLabelText(/API key/));
        await userEvent.type(screen.getByLabelText(/API key/), 'api-0123456789abcdef0123');
        await userEvent.type(screen.getByLabelText(/DKIM selector/), 's123');
        await userEvent.click(screen.getByRole('button', { name: 'Add mailbox' }));
        await waitFor(() =>
            expect(seen.find((r) => r.method === 'POST')?.body).toEqual({
                email: 'hello@outreach-mail.example',
                apiKey: 'api-0123456789abcdef0123',
                dkimSelector: 's123',
            }),
        );
        const card = await screen.findByRole('region', { name: 'SMTP2Go mailbox hello@outreach-mail.example' });
        expect(within(card).getByText(added.hookUrl)).toBeInTheDocument();
        expect(within(card).getByText('Bearer secret-value')).toBeInTheDocument();
        // The API key went once, in the request; nothing shows it back.
        expect(screen.queryByText(/api-0123456789abcdef0123/)).toBeNull();
        expect(within(card).getByText('No events yet')).toBeInTheDocument();
    });
    it('sends a test through the mailbox and says inline whether it went', async () => {
        let answer: unknown = { outcome: 'sent', to: 'kate@pinion.example', outboundId: 'o-1', error: null };
        const seen = stubApi([
            (r) => (r.method === 'GET' && r.url.endsWith('/smtp2go/mailboxes') ? json([added]) : undefined),
            (r) => (r.method === 'POST' && r.url.endsWith('/smtp2go/mailboxes/mb-s2g/test') ? json(answer) : undefined),
        ]);
        open();
        await userEvent.click(await screen.findByRole('button', { name: 'Send test' }));
        expect(await screen.findByText(/^Sent to kate@pinion\.example through SMTP2Go\./)).toBeInTheDocument();
        expect(seen.filter((r) => r.method === 'POST')).toHaveLength(1);

        answer = {
            outcome: 'refused',
            to: 'kate@pinion.example',
            outboundId: 'o-2',
            error: { code: 'smtp2go.E_ApiResponseCodes.API_KEY_INVALID', message: 'SMTP2Go refused the message (401)' },
        };
        await userEvent.click(screen.getByRole('button', { name: 'Send test' }));
        expect(
            await screen.findByText('Not sent to kate@pinion.example: SMTP2Go refused the message (401).'),
        ).toBeInTheDocument();
    });
});

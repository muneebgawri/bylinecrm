import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SuppressionView } from '../../../api/types';
import { json, renderAt, route, stubApi, type FakeRoute } from './settingsTestKit';
import { Suppression } from './Suppression';

const entry = (over: Partial<SuppressionView>): SuppressionView => ({
    id: 's1',
    address: 'jordan@northwind.example',
    reason: 'unsubscribe',
    source: 'recipient',
    personId: null,
    note: null,
    createdByMemberId: null,
    createdAt: '2026-10-10T10:00:00Z',
    liftable: false,
    ...over,
});

const entries = [
    entry({}),
    entry({ id: 's2', address: 'old@contoso.example', reason: 'hard_bounce', source: 'provider', liftable: true }),
];

const listed: FakeRoute = (r) =>
    r.method === 'GET' && r.url.includes('/suppressions') ? json({ items: entries, nextCursor: null }) : undefined;

const open = (capabilities: Parameters<typeof renderAt>[2]) =>
    renderAt(
        [route('/w/:workspaceId/settings/suppression', <Suppression />)],
        '/w/ws-1/settings/suppression',
        capabilities,
    );

describe('FR-CRMS-7 Settings → Suppression', { timeout: 20_000 }, () => {
    afterEach(() => vi.unstubAllGlobals());

    it('lists the suppressed addresses with their reason; an admin may lift only a liftable entry', async () => {
        stubApi([listed]);
        open(['outreach:write', 'workspace:admin']);
        expect(await screen.findByText('jordan@northwind.example')).toBeInTheDocument();
        expect(screen.getByText('Unsubscribed', { selector: 'span' })).toBeInTheDocument();
        expect(screen.getByText('Hard bounce')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Actions for jordan@northwind.example' })).toBeNull();
        expect(screen.getByRole('button', { name: 'Actions for old@contoso.example' })).toBeInTheDocument();
    });

    it('offers no lifting to a member who is not an admin', async () => {
        stubApi([listed]);
        open(['outreach:write']);
        expect(await screen.findByText('old@contoso.example')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /^Actions for/ })).toBeNull();
    });

    it('catches a mistyped address before sending, and sends a correct one normalised', async () => {
        const seen = stubApi([
            listed,
            (r) =>
                r.method === 'POST'
                    ? json(entry({ id: 's3', address: 'dana@acme.example', reason: 'manual', source: 'member' }), 201)
                    : undefined,
        ]);
        open(['outreach:write']);
        await userEvent.click(await screen.findByRole('button', { name: 'Suppress an address' }));
        const dialog = await screen.findByRole('dialog');
        await userEvent.type(within(dialog).getByLabelText(/^Address/), 'not an address');
        await userEvent.click(within(dialog).getByRole('button', { name: 'Suppress' }));
        expect(await within(dialog).findByText('Enter an address like someone@example.com.')).toBeInTheDocument();
        expect(seen.filter((r) => r.method === 'POST')).toHaveLength(0);

        await userEvent.clear(within(dialog).getByLabelText(/^Address/));
        await userEvent.type(within(dialog).getByLabelText(/^Address/), '  Dana@ACME.example ');
        await userEvent.type(within(dialog).getByLabelText(/^Note/), 'asked on a call');
        await userEvent.click(within(dialog).getByRole('button', { name: 'Suppress' }));
        await waitFor(() => expect(seen.filter((r) => r.method === 'POST')).toHaveLength(1));
        expect(seen.find((r) => r.method === 'POST')?.body).toEqual({
            address: 'dana@acme.example',
            note: 'asked on a call',
        });
    });

    it('lifts an entry only with a note saying why', async () => {
        const seen = stubApi([
            listed,
            (r) => (r.method === 'POST' && r.url.endsWith('/s2/remove') ? json(null, 204) : undefined),
        ]);
        open(['outreach:write', 'workspace:admin']);
        await userEvent.click(await screen.findByRole('button', { name: 'Actions for old@contoso.example' }));
        await userEvent.click(await screen.findByRole('menuitem', { name: 'Lift' }));
        const dialog = await screen.findByRole('dialog');
        const lift = within(dialog).getByRole('button', { name: 'Lift' });
        expect(lift).toBeDisabled();
        await userEvent.type(within(dialog).getByLabelText(/^Why/), 'the inbox works again');
        await userEvent.click(lift);
        await waitFor(() => expect(seen.some((r) => r.url.endsWith('/s2/remove'))).toBe(true));
        expect(seen.find((r) => r.url.endsWith('/s2/remove'))?.body).toEqual({ note: 'the inbox works again' });
    });
});

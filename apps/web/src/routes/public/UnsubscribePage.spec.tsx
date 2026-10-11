import { ThemeProvider } from '@bylinecrm/ui';
import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '../../api/queries';
import { apiError, json, stubApi, type FakeRoute } from '../w/settings/settingsTestKit';
import { UnsubscribePage } from './UnsubscribePage';

function open() {
    const router = createMemoryRouter([{ path: '/unsubscribe/:token', element: <UnsubscribePage /> }], {
        initialEntries: ['/unsubscribe/tok_123'],
    });
    render(
        <QueryClientProvider client={createQueryClient()}>
            <ThemeProvider>
                <RouterProvider router={router} />
            </ThemeProvider>
        </QueryClientProvider>,
    );
}

const status =
    (unsubscribed: boolean): FakeRoute =>
    (r) =>
        r.method === 'GET' && r.url.endsWith('/unsubscribe/tok_123/status')
            ? json({ recipient: 'd•••@acme.example', unsubscribed })
            : undefined;

describe('FR-CRMS-7 the unsubscribe page', { timeout: 20_000 }, () => {
    afterEach(() => vi.unstubAllGlobals());

    it('changes nothing by being opened: it asks, and unsubscribes only on the button', async () => {
        const seen = stubApi([
            status(false),
            (r) =>
                r.method === 'POST' && r.url.endsWith('/unsubscribe/tok_123')
                    ? json({ recipient: 'd•••@acme.example', unsubscribed: true })
                    : undefined,
        ]);
        open();
        expect(await screen.findByText('d•••@acme.example')).toBeInTheDocument();
        expect(seen.filter((r) => r.method === 'POST')).toHaveLength(0);
        expect(document.title).toBe('Unsubscribe');
        await userEvent.click(screen.getByRole('button', { name: 'Unsubscribe' }));
        expect(await screen.findByRole('heading', { name: 'You’re unsubscribed' })).toBeInTheDocument();
        await waitFor(() => expect(seen.filter((r) => r.method === 'POST')).toHaveLength(1));
    });

    it('says so at once when the address is already unsubscribed', async () => {
        stubApi([status(true)]);
        open();
        expect(await screen.findByRole('heading', { name: 'You’re unsubscribed' })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Unsubscribe' })).toBeNull();
    });

    it('says the link is not valid when the token is unknown', async () => {
        stubApi([() => apiError(404, 'not_found', 'unsubscribe link not found')]);
        open();
        expect(await screen.findByRole('heading', { name: 'This link is not valid' })).toBeInTheDocument();
    });
});

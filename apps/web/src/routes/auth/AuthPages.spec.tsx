import { ThemeProvider } from '@bylinecrm/ui';
import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '../../api/queries';
import { routes } from '../manifest';
import { paths } from '../paths';

function renderAt(path: string) {
    const router = createMemoryRouter(routes, { initialEntries: [path] });
    render(
        <QueryClientProvider client={createQueryClient()}>
            <ThemeProvider>
                <RouterProvider router={router} />
            </ThemeProvider>
        </QueryClientProvider>,
    );
}

/**
 * #102: the signed-out pages are their own chunk. Opened directly, the page draws the auth card's
 * shape while its code loads (FR-CRMS-UI-7), then the page itself in the same place.
 */
describe('#102 FR-CRMS-UI-7: a signed-out page opened directly', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('shows the auth card loading, then the sign-in form', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(() => new Promise<Response>(() => {})),
        );
        renderAt(paths.signIn);
        expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
        expect(await screen.findByRole('heading', { level: 1 })).toBeInTheDocument();
        expect(screen.queryByRole('status', { name: 'Loading' })).not.toBeInTheDocument();
    });
});

import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useLocation } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '../api/queries';
import { paths } from '../routes/paths';
import { RequireAuth } from './RequireAuth';

function ShowLocation() {
    const location = useLocation();
    return <output>{location.pathname + location.search}</output>;
}

function renderAt(path: string) {
    const router = createMemoryRouter(
        [
            { path: paths.signIn, element: <ShowLocation /> },
            { path: paths.verifyEmail, element: <ShowLocation /> },
            {
                element: <RequireAuth pending={<p>checking</p>} />,
                children: [{ path: '/w/:workspaceId/people', element: <p>people page</p> }],
            },
        ],
        { initialEntries: [path] },
    );
    return render(
        <QueryClientProvider client={createQueryClient()}>
            <RouterProvider router={router} />
        </QueryClientProvider>,
    );
}

function stubMe(status: number, body: unknown) {
    vi.stubGlobal(
        'fetch',
        vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status }))),
    );
}

describe('RequireAuth', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('renders the protected route once the API knows the person', async () => {
        stubMe(200, { id: 'u1', email: 'a@b.c', emailVerified: true });
        renderAt('/w/ws-1/people');
        expect(screen.getByText('checking')).toBeInTheDocument();
        expect(await screen.findByText('people page')).toBeInTheDocument();
    });

    it('sends a signed-out person to sign-in, remembering where they were', async () => {
        stubMe(401, { statusCode: 401, code: 'unauthorized', message: 'Unauthorized', requestId: 'req-0123456789' });
        renderAt('/w/ws-1/people?view=mine');
        const location = await screen.findByRole('status');
        expect(location).toHaveTextContent(
            `${paths.signIn}?returnTo=${encodeURIComponent('/w/ws-1/people?view=mine')}`,
        );
    });

    it('#93: holds a signed-in person whose address is not verified on the verify page', async () => {
        stubMe(200, { id: 'u', email: 'a@b.c', emailVerified: false });
        renderAt('/w/ws-1/people');
        expect(await screen.findByRole('status')).toHaveTextContent(paths.verifyEmail);
        expect(screen.queryByText('people page')).not.toBeInTheDocument();
    });
});

import { ThemeProvider, TooltipProvider } from '@bylinecrm/ui';
import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '../api/queries';
import { routes } from '../routes/manifest';

const WS = '11111111-2222-4333-8444-555555555555';
const PERSON = '22222222-2222-4333-8444-555555555555';

function renderAt(path: string) {
    const router = createMemoryRouter(routes, { initialEntries: [path] });
    render(
        <QueryClientProvider client={createQueryClient()}>
            <ThemeProvider>
                <TooltipProvider>
                    <RouterProvider router={router} />
                </TooltipProvider>
            </ThemeProvider>
        </QueryClientProvider>,
    );
    return router;
}

const json = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

/**
 * Exit check item 8 (FR-CRMS-UI-7): a record URL opened directly drew a full-screen skeleton with
 * no shell for seconds, then the shell appeared and the page jumped. The shell is the frame every
 * workspace page sits in; it is there from the first frame, and only the content area waits.
 */
describe('FR-CRMS-UI-7: a record URL opened directly', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('draws the sidebar and the top bar in the first frame, with the content area loading', () => {
        // Nothing answers yet: who the person is, their standing, the record — all pending.
        vi.stubGlobal(
            'fetch',
            vi.fn(() => new Promise<Response>(() => {})),
        );
        renderAt(`/w/${WS}/people/${PERSON}`);
        expect(screen.getByRole('complementary', { name: 'Sidebar' })).toBeInTheDocument();
        expect(screen.getByRole('banner')).toBeInTheDocument();
        expect(screen.getByRole('main')).toContainElement(screen.getAllByRole('status', { name: 'Loading' })[0]!);
    });

    it('keeps the same shell when the answers arrive — the frame is not redrawn', async () => {
        let release: () => void = () => {};
        const answered = new Promise<void>((resolve) => {
            release = resolve;
        });
        vi.stubGlobal(
            'fetch',
            vi.fn(async (input: string) => {
                await answered;
                const path = String(input).split('?')[0] ?? '';
                if (path.endsWith('/me/workspaces')) return json([{ id: WS, slug: 'p', name: 'Pinion Partners' }]);
                if (path.endsWith('/me/profile'))
                    return json({ email: 'kate@example.test', displayName: 'Kate Morgan', completed: true });
                if (path.endsWith('/api/me')) return json({ id: 'u', email: 'kate@example.test', emailVerified: true });
                return json({});
            }),
        );
        renderAt(`/w/${WS}/people/${PERSON}`);
        const first = screen.getByRole('complementary', { name: 'Sidebar' });
        release();
        await waitFor(() => expect(screen.getByText('Pinion Partners')).toBeInTheDocument());
        expect(screen.getByRole('complementary', { name: 'Sidebar' })).toBe(first);
    });
});

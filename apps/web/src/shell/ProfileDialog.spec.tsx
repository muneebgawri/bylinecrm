import { ThemeProvider, TooltipProvider } from '@bylinecrm/ui';
import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '../api/queries';
import { routes } from '../routes/manifest';

const WS = '11111111-2222-4333-8444-555555555555';

interface Call {
    method: string;
    path: string;
    body: unknown;
}

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** The API a freshly signed-up person meets: a suggested name they have not confirmed yet. */
function api(calls: Call[], completed: boolean) {
    let profile = { email: 'kate.morgan@example.test', displayName: 'kate.morgan', completed };
    return vi.fn(async (input: string, init?: RequestInit) => {
        const path = String(input).split('?')[0] ?? '';
        const method = init?.method ?? 'GET';
        const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
        calls.push({ method, path, body });
        if (path.endsWith('/me/profile') && method === 'PATCH') {
            profile = { ...profile, displayName: (body as { displayName: string }).displayName, completed: true };
            return json(profile);
        }
        if (path.endsWith('/me/profile')) return json(profile);
        if (path.endsWith('/me/workspaces')) return json([{ id: WS, slug: 'p', name: 'Pinion Partners' }]);
        if (path.endsWith('/api/me')) return json({ id: 'u', email: profile.email, emailVerified: true });
        if (path.endsWith(`/w/${WS}/me`))
            return json({
                workspaceId: WS,
                memberId: 'm',
                userId: 'u',
                apiKeyId: null,
                roleId: 'r',
                roleName: 'admin',
                recordScope: 'all',
                capabilities: ['record:read'],
            });
        return json({});
    });
}

function renderHome() {
    const router = createMemoryRouter(routes, { initialEntries: [`/w/${WS}/home`] });
    render(
        <QueryClientProvider client={createQueryClient()}>
            <ThemeProvider>
                <TooltipProvider>
                    <RouterProvider router={router} />
                </TooltipProvider>
            </ThemeProvider>
        </QueryClientProvider>,
    );
}

/**
 * Exit check item 11: members were named by their address's local part, silently. A person now
 * confirms the name their team sees — asked once after sign-up, editable any time from the user
 * menu and the palette — and that one name is shown in every workspace.
 */
describe('the display name', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('asks once after sign-up, suggesting a name; keeping the suggestion confirms it', async () => {
        const calls: Call[] = [];
        vi.stubGlobal('fetch', api(calls, false));
        renderHome();
        const dialog = await screen.findByRole('dialog', { name: 'What should your team call you?' });
        expect(within(dialog).getByRole('textbox', { name: 'Your name' })).toHaveValue('kate.morgan');
        await userEvent.click(within(dialog).getByRole('button', { name: 'Not now' }));
        await waitFor(() =>
            expect(calls.find((c) => c.method === 'PATCH')).toMatchObject({
                path: '/api/me/profile',
                body: { displayName: 'kate.morgan' },
            }),
        );
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    });

    it('saves a new name, trimmed', async () => {
        const calls: Call[] = [];
        vi.stubGlobal('fetch', api(calls, false));
        renderHome();
        const dialog = await screen.findByRole('dialog', { name: 'What should your team call you?' });
        const input = within(dialog).getByRole('textbox', { name: 'Your name' });
        await userEvent.clear(input);
        await userEvent.type(input, '  Kate Morgan  ');
        await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
        await waitFor(() =>
            expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ displayName: 'Kate Morgan' }),
        );
    });

    it('does not ask a person who has confirmed their name', async () => {
        const calls: Call[] = [];
        vi.stubGlobal('fetch', api(calls, true));
        renderHome();
        await screen.findByText('Pinion Partners');
        await waitFor(() => expect(calls.some((c) => c.path === '/api/me/profile')).toBe(true));
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('opens from the user menu to change the name later', async () => {
        const calls: Call[] = [];
        vi.stubGlobal('fetch', api(calls, true));
        renderHome();
        await userEvent.click(await screen.findByRole('button', { name: /kate\.morgan/i }));
        await userEvent.click(await screen.findByRole('menuitem', { name: 'Edit profile' }));
        expect(await screen.findByRole('dialog', { name: 'Your profile' })).toBeInTheDocument();
    });
});

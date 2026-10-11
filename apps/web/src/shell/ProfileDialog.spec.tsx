import { ThemeProvider, TooltipProvider } from '@bylinecrm/ui';
import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '../api/queries';
import { routes } from '../routes/manifest';

const WS = '11111111-2222-4333-8444-555555555555';
/** jsdom renders the lazy shell slowly on a cold worker; the assertion is "it appears", not a speed. */
const FIRST_RENDER_MS = 8_000;

interface Call {
    method: string;
    path: string;
    body: unknown;
}

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/**
 * The API a freshly signed-up person meets: a suggested name they have not confirmed yet. A person
 * who has confirmed one is "Kate Morgan" — a name the email cannot produce, so finding it on screen
 * means the profile has loaded.
 */
function api(calls: Call[], completed: boolean) {
    let profile = {
        email: 'kate.morgan@example.test',
        displayName: completed ? 'Kate Morgan' : 'kate.morgan',
        completed,
    };
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
        if (path.endsWith('/members/summary')) return json([]);
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
describe('the display name', { timeout: 20_000 }, () => {
    afterEach(() => vi.unstubAllGlobals());

    it('asks once after sign-up, suggesting a name; keeping the suggestion confirms it', async () => {
        const calls: Call[] = [];
        vi.stubGlobal('fetch', api(calls, false));
        renderHome();
        const dialog = await screen.findByRole(
            'dialog',
            { name: 'What should your team call you?' },
            { timeout: FIRST_RENDER_MS },
        );
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
        const dialog = await screen.findByRole(
            'dialog',
            { name: 'What should your team call you?' },
            { timeout: FIRST_RENDER_MS },
        );
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
        await screen.findByText('Pinion Partners', undefined, { timeout: FIRST_RENDER_MS });
        await waitFor(() => expect(calls.some((c) => c.path === '/api/me/profile')).toBe(true));
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('opens from the user menu to change the name later', async () => {
        const calls: Call[] = [];
        vi.stubGlobal('fetch', api(calls, true));
        renderHome();
        const user = userEvent.setup();
        await user.click(await screen.findByRole('button', { name: /Kate Morgan/ }, { timeout: FIRST_RENDER_MS }));
        await user.click(await screen.findByRole('menuitem', { name: 'Edit profile' }));
        const dialog = await screen.findByRole('dialog', { name: 'Your profile' });
        expect(within(dialog).getByRole('textbox', { name: 'Your name' })).toHaveValue('Kate Morgan');
    });
});

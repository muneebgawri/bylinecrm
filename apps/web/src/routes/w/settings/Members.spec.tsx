import { ThemeProvider, TooltipProvider, toasts } from '@bylinecrm/ui';
import { Toaster } from '@bylinecrm/ui/toaster';
import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '../../../api/queries';
import { Members } from './Members';

const members = [
    {
        id: 'm1',
        userId: 'u1',
        email: 'kate@pinion.co',
        displayName: 'Kate Morgan',
        roleId: 'r1',
        roleName: 'admin',
        createdAt: '2026-10-01T10:00:00Z',
    },
    {
        id: 'm2',
        userId: 'u2',
        email: 'sam@pinion.co',
        displayName: 'Sam Okafor',
        roleId: 'r2',
        roleName: 'member',
        createdAt: '2026-10-02T10:00:00Z',
    },
];
/** An account the Twenty import created (#184): no credential yet, so not signed in. */
const imported = {
    id: 'm3',
    userId: 'u3',
    email: 'pat@pinion.co',
    displayName: 'Pat Manager',
    roleId: 'r2',
    roleName: 'member',
    createdAt: '2026-10-03T10:00:00Z',
    hasSignedIn: false,
};
const roles = [
    { id: 'r1', name: 'admin', isSystem: true, capabilities: [] },
    { id: 'r2', name: 'member', isSystem: true, capabilities: ['record:read'] },
];

describe('Members', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        toasts.clear();
    });

    it('lists the workspace members with their roles, marking the signed-in one', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn((url: string) => {
                const body = url.endsWith('/members')
                    ? members
                    : url.endsWith('/roles')
                      ? roles
                      : { id: 'u1', email: 'kate@pinion.co', emailVerified: true };
                return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
            }),
        );
        const router = createMemoryRouter([{ path: '/w/:workspaceId/settings/members', element: <Members /> }], {
            initialEntries: ['/w/ws-1/settings/members'],
        });
        render(
            <QueryClientProvider client={createQueryClient()}>
                <ThemeProvider>
                    <TooltipProvider>
                        <RouterProvider router={router} />
                    </TooltipProvider>
                </ThemeProvider>
            </QueryClientProvider>,
        );
        expect(await screen.findByText('sam@pinion.co')).toBeInTheDocument();
        expect(screen.getAllByText('admin')).not.toHaveLength(0);
        expect(await screen.findByText('You')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Actions for sam@pinion.co' })).toBeInTheDocument();
    });

    it('#184: a member who has not signed in yet is marked so, and an admin sends them the invitation from their row', async () => {
        const seen: { method: string; url: string; body: unknown }[] = [];
        vi.stubGlobal(
            'fetch',
            vi.fn((url: string, init?: RequestInit) => {
                seen.push({
                    method: init?.method ?? 'GET',
                    url,
                    body: init?.body ? JSON.parse(String(init.body)) : null,
                });
                if (init?.method === 'POST' && url.endsWith('/invites')) {
                    return Promise.resolve(
                        new Response(
                            JSON.stringify({
                                invite: {
                                    id: 'i1',
                                    email: imported.email,
                                    roleId: 'r2',
                                    expiresAt: '2026-10-20T10:00:00Z',
                                    acceptedAt: null,
                                },
                                token: 't',
                            }),
                            { status: 201 },
                        ),
                    );
                }
                const body = url.endsWith('/members')
                    ? [...members.map((m) => ({ ...m, hasSignedIn: true })), imported]
                    : url.endsWith('/roles')
                      ? roles
                      : { id: 'u1', email: 'kate@pinion.co', emailVerified: true };
                return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
            }),
        );
        const router = createMemoryRouter(
            [
                {
                    path: '/w/:workspaceId/settings/members',
                    element: (
                        <>
                            <Members />
                            <Toaster />
                        </>
                    ),
                },
            ],
            { initialEntries: ['/w/ws-1/settings/members'] },
        );
        render(
            <QueryClientProvider client={createQueryClient()}>
                <ThemeProvider>
                    <TooltipProvider>
                        <RouterProvider router={router} />
                    </TooltipProvider>
                </ThemeProvider>
            </QueryClientProvider>,
        );
        const row = (await screen.findByText('pat@pinion.co')).closest('tr')!;
        expect(within(row).getByText('Not signed in yet')).toBeInTheDocument();
        expect(screen.queryAllByText('Not signed in yet')).toHaveLength(1);
        const user = userEvent.setup();
        await user.click(within(row).getByRole('button', { name: 'Actions for pat@pinion.co' }));
        await user.click(await screen.findByRole('menuitem', { name: 'Send invitation' }));
        await waitFor(() =>
            expect(seen.find((r) => r.method === 'POST' && r.url.endsWith('/invites'))?.body).toEqual({
                email: 'pat@pinion.co',
                roleId: 'r2',
            }),
        );
        expect(await screen.findByText(/Invitation sent to pat@pinion.co/)).toBeInTheDocument();
    });
});

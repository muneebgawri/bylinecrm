import { ThemeProvider, TooltipProvider } from '@bylinecrm/ui';
import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '../../../api/queries';
import { Members } from './Members';

const members = [
    {
        id: 'm1',
        userId: 'u1',
        email: 'kate@pinion.co',
        roleId: 'r1',
        roleName: 'admin',
        createdAt: '2026-10-01T10:00:00Z',
    },
    {
        id: 'm2',
        userId: 'u2',
        email: 'sam@pinion.co',
        roleId: 'r2',
        roleName: 'member',
        createdAt: '2026-10-02T10:00:00Z',
    },
];
const roles = [
    { id: 'r1', name: 'admin', isSystem: true, capabilities: [] },
    { id: 'r2', name: 'member', isSystem: true, capabilities: ['record:read'] },
];

describe('Members', () => {
    afterEach(() => vi.unstubAllGlobals());

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
});

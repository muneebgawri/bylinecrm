import { ThemeProvider, TooltipProvider } from '@bylinecrm/ui';
import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '../api/queries';
import type { MembershipSummary } from '../api/types';
import { CapabilitiesProvider } from '../auth/capabilities';
import { Sidebar, displayName } from './Sidebar';

const member: MembershipSummary = {
    memberId: 'm',
    userId: 'u',
    roleId: 'r',
    roleName: 'member',
    recordScope: 'own',
    capabilities: ['record:read', 'deal:read'],
};

function renderSidebar(membership: MembershipSummary | null, collapsed = false) {
    vi.stubGlobal(
        'fetch',
        vi.fn((url: string) =>
            Promise.resolve(
                new Response(
                    JSON.stringify(
                        url.endsWith('/me')
                            ? { id: 'u', email: 'kate.morgan@pinionpartners.co', emailVerified: true }
                            : [{ id: 'ws-1', slug: 'pinion', name: 'Pinion Partners' }],
                    ),
                    { status: 200 },
                ),
            ),
        ),
    );
    const router = createMemoryRouter(
        [
            {
                path: '/w/:workspaceId/*',
                element: (
                    <CapabilitiesProvider membership={membership}>
                        <Sidebar workspaceId="ws-1" collapsed={collapsed} onOpenShortcuts={() => undefined} />
                    </CapabilitiesProvider>
                ),
            },
        ],
        { initialEntries: ['/w/ws-1/people'] },
    );
    return render(
        <QueryClientProvider client={createQueryClient()}>
            <ThemeProvider>
                <TooltipProvider>
                    <RouterProvider router={router} />
                </TooltipProvider>
            </ThemeProvider>
        </QueryClientProvider>,
    );
}

describe('Sidebar', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('shows only the items the member may use, and marks the current one', async () => {
        renderSidebar(member);
        expect(await screen.findByRole('link', { name: 'People' })).toHaveAttribute('aria-current', 'page');
        expect(screen.getByRole('link', { name: 'Deals' })).toBeInTheDocument();
        expect(screen.getByRole('link', { name: 'Dashboard' })).toBeInTheDocument();
        expect(screen.queryByRole('link', { name: 'Settings' })).not.toBeInTheDocument();
        expect(screen.queryByRole('link', { name: 'Sequences' })).not.toBeInTheDocument();
        expect(await screen.findByText('Pinion Partners')).toBeInTheDocument();
        expect(await screen.findByText('kate.morgan@pinionpartners.co')).toBeInTheDocument();
    });

    it('shows nothing gated while the membership is unknown', async () => {
        renderSidebar(null);
        expect(await screen.findByRole('link', { name: 'Dashboard' })).toBeInTheDocument();
        expect(screen.queryByRole('link', { name: 'People' })).not.toBeInTheDocument();
    });

    it('keeps every link when collapsed, named for assistive tech', async () => {
        renderSidebar(member, true);
        expect(await screen.findByRole('link', { name: 'People' })).toBeInTheDocument();
    });
});

describe('displayName', () => {
    it('reads a name out of an email until profiles exist', () => {
        expect(displayName('kate.morgan@pinionpartners.co')).toBe('Kate Morgan');
        expect(displayName('ops@x.io')).toBe('Ops');
    });
});

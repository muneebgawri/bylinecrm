import type { Capability } from '@bylinecrm/shared';
import { ThemeProvider, TooltipProvider } from '@bylinecrm/ui';
import { QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { createMemoryRouter, RouterProvider, type RouteObject } from 'react-router';
import { vi } from 'vitest';
import { createQueryClient } from '../../../api/queries';
import type { MembershipSummary } from '../../../api/types';
import { CapabilitiesProvider } from '../../../auth/capabilities';

/** A test's view of the API: every request it saw, and the answer it gives each. */
export interface FakeRequest {
    method: string;
    url: string;
    body: unknown;
}

export type FakeRoute = (request: FakeRequest) => Response | undefined;

export const json = (body: unknown, status = 200) =>
    new Response(status === 204 ? null : JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });

/** The API's one error envelope (P1-1d), as the server sends it. */
export const apiError = (status: number, code: string, message: string) =>
    json({ statusCode: status, code, message, requestId: 'req-test' }, status);

/**
 * Stubs `fetch` with an ordered list of routes; the first that answers wins. Every request is
 * recorded so a test asserts on what the page sent, not on how it sent it.
 */
export function stubApi(routes: FakeRoute[]): FakeRequest[] {
    const seen: FakeRequest[] = [];
    vi.stubGlobal(
        'fetch',
        vi.fn((url: string, init?: RequestInit) => {
            const request: FakeRequest = {
                method: init?.method ?? 'GET',
                url,
                body: init?.body ? JSON.parse(String(init.body)) : undefined,
            };
            seen.push(request);
            for (const route of routes) {
                const response = route(request);
                if (response) return Promise.resolve(response);
            }
            return Promise.resolve(apiError(404, 'not_found', `no fake for ${request.method} ${url}`));
        }),
    );
    return seen;
}

export const membership = (capabilities: Capability[]): MembershipSummary => ({
    memberId: 'm-1',
    workspaceId: 'ws-1',
    apiKeyId: null,
    userId: 'u-1',
    roleId: 'r-1',
    roleName: 'admin',
    recordScope: 'all',
    capabilities,
});

/** Renders a settings page inside the providers it needs, at `entry`. */
export function renderAt(routes: RouteObject[], entry: string, capabilities: Capability[]): ReturnType<typeof render> {
    const router = createMemoryRouter(routes, { initialEntries: [entry] });
    return render(
        <QueryClientProvider client={createQueryClient()}>
            <ThemeProvider>
                <TooltipProvider>
                    <CapabilitiesProvider membership={membership(capabilities)}>
                        <RouterProvider router={router} />
                    </CapabilitiesProvider>
                </TooltipProvider>
            </ThemeProvider>
        </QueryClientProvider>,
    );
}

export const route = (path: string, element: ReactElement): RouteObject => ({ path, element });

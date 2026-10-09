import { CAPABILITIES } from '@bylinecrm/shared';
import { ThemeProvider, TooltipProvider } from '@bylinecrm/ui';
import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '../../../api/queries';
import type { MembershipSummary } from '../../../api/types';
import { CapabilitiesProvider } from '../../../auth/capabilities';
import { encodeFilter } from '../../../lib/filterParam';
import { PeopleListPage } from './ListPage';

const WS = '11111111-2222-4333-8444-555555555555';
const ME = 'aaaaaaaa-0000-4000-8000-000000000001';

const person = (id: string, nameFirst: string, nameLast: string) => ({
    id,
    nameFirst,
    nameLast,
    emails: { primary: `${nameFirst.toLowerCase()}@acme.example`, additional: [] },
    phones: { primary: null, additional: [] },
    jobTitle: 'Head of Comms',
    city: 'Austin',
    links: {},
    avatarUrl: null,
    position: 0,
    companyId: null,
    ownerId: ME,
    createdBy: { kind: 'member', id: ME },
    custom: {},
    deletedAt: null,
    createdAt: '2026-10-01T10:00:00.000Z',
    updatedAt: '2026-10-08T10:00:00.000Z',
});

const PEOPLE = [person('p1', 'Dana', 'Reyes'), person('p2', 'Sam', 'Okafor')];
const MINE = {
    id: 'v1',
    object: 'person',
    name: 'My leads',
    icon: null,
    ownerMemberId: ME,
    isShared: false,
    filter: { and: [{ field: 'city', op: 'eq', value: 'Austin' }] },
    sorts: [],
    columns: [],
    groupBy: null,
    position: 0,
    createdAt: '2026-10-01T10:00:00.000Z',
    updatedAt: '2026-10-01T10:00:00.000Z',
};

const membership: MembershipSummary = {
    memberId: ME,
    userId: 'u1',
    roleId: 'r1',
    roleName: 'admin',
    recordScope: 'all',
    capabilities: CAPABILITIES,
};

interface Call {
    method: string;
    url: string;
    body: unknown;
}

function json(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** A fetch that answers the list page's routes and records every call. */
function api(calls: Call[]) {
    return vi.fn(async (input: string, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        const path = url.split('?')[0] ?? '';
        if (path.endsWith('/people')) return json({ items: PEOPLE, nextCursor: null });
        if (path.endsWith('/views') && method === 'GET') return json([MINE]);
        if (path.endsWith('/views') && method === 'POST') {
            return json({ ...MINE, id: 'v2', name: (calls.at(-1)?.body as { name: string }).name }, 201);
        }
        if (path.endsWith('/views/v1') && method === 'PATCH')
            return json({ ...MINE, ...(calls.at(-1)?.body as object) });
        if (path.endsWith('/custom-fields')) return json([]);
        if (path.endsWith('/members/summary')) return json([{ memberId: ME, name: 'Kate Morgan' }]);
        return json({});
    });
}

function renderAt(search: string) {
    const router = createMemoryRouter([{ path: '/w/:workspaceId/people', element: <PeopleListPage /> }], {
        initialEntries: [`/w/${WS}/people${search}`],
    });
    render(
        <ThemeProvider>
            <TooltipProvider>
                <QueryClientProvider client={createQueryClient()}>
                    <CapabilitiesProvider membership={membership}>
                        <RouterProvider router={router} />
                    </CapabilitiesProvider>
                </QueryClientProvider>
            </TooltipProvider>
        </ThemeProvider>,
    );
    return router;
}

/**
 * jsdom lays nothing out, so every element measures 0×0 and a virtualised list renders no rows.
 * The table's scroll container is given a screen's size here; nothing else reads these.
 */
const layout = {
    offsetWidth: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth'),
    offsetHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight'),
};

describe('People list', () => {
    const width = window.innerWidth;
    beforeEach(() => {
        window.innerWidth = 1280;
        Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 1280 });
        Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 800 });
    });
    afterEach(() => {
        window.innerWidth = width;
        if (layout.offsetWidth) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', layout.offsetWidth);
        if (layout.offsetHeight) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', layout.offsetHeight);
        vi.unstubAllGlobals();
    });

    it('sends the URL filter and shows the rows in a table', async () => {
        const calls: Call[] = [];
        vi.stubGlobal('fetch', api(calls));
        const filter = encodeFilter({ and: [{ field: 'city', op: 'eq', value: 'Austin' }] });
        renderAt(`?filter=${filter}&sort=nameLast:asc`);

        // The first render in the file also loads the page's chunk; it is given that time.
        expect(await screen.findByRole('button', { name: 'Dana Reyes' }, { timeout: 3000 })).toBeInTheDocument();
        expect(screen.getByRole('table')).toBeInTheDocument();
        const list = calls.find((c) => c.url.includes('/people?'));
        expect(list?.url).toContain(`filter=${filter}`);
        expect(list?.url).toContain('sort=nameLast%3Aasc');
    });

    it('saves the current filter, sort and columns as a new view and opens it', async () => {
        const user = userEvent.setup();
        const calls: Call[] = [];
        vi.stubGlobal('fetch', api(calls));
        const router = renderAt('?sort=nameLast:desc');
        await screen.findByRole('button', { name: 'Dana Reyes' });

        await user.click(screen.getByRole('button', { name: 'Save changes' }));
        await user.click(await screen.findByRole('menuitem', { name: 'Save as new view…' }));
        const dialog = await screen.findByRole('dialog', { name: 'Save view' });
        await user.click(within(dialog).getByRole('textbox', { name: /Name/ }));
        await user.paste('Austin heads');
        await user.click(within(dialog).getByRole('button', { name: 'Save view' }));

        await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/views'))).toBe(true));
        const post = calls.find((c) => c.method === 'POST' && c.url.endsWith('/views'));
        expect(post?.body).toMatchObject({
            object: 'person',
            name: 'Austin heads',
            sorts: [{ field: 'nameLast', direction: 'desc' }],
            columns: expect.arrayContaining([expect.objectContaining({ field: 'nameFirst' })]),
        });
        await waitFor(() => expect(router.state.location.search).toContain('view=v2'));
        expect(router.state.location.search).not.toContain('sort=');
    });

    it("updates the open view with what changed, if it is the member's own", async () => {
        const user = userEvent.setup();
        const calls: Call[] = [];
        vi.stubGlobal('fetch', api(calls));
        renderAt('?view=v1&sort=updatedAt:desc');
        await screen.findByRole('button', { name: 'Dana Reyes' });

        await user.click(screen.getByRole('button', { name: 'Save changes' }));
        await user.click(await screen.findByRole('menuitem', { name: 'Update “My leads”' }));
        await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
        expect(calls.find((c) => c.method === 'PATCH')).toMatchObject({
            url: `/api/w/${WS}/views/v1`,
            body: { sorts: [{ field: 'updatedAt', direction: 'desc' }], filter: MINE.filter },
        });
    });

    it('shows stacked cards, not a table, on a 375px phone', async () => {
        window.innerWidth = 375;
        vi.stubGlobal('fetch', api([]));
        renderAt('');
        const cards = await screen.findByRole('list', { name: 'People' });
        expect(within(cards).getAllByRole('button')).toHaveLength(2);
        expect(within(cards).getByText('Dana Reyes')).toBeInTheDocument();
        expect(screen.queryByRole('table')).not.toBeInTheDocument();
        expect(screen.getByRole('searchbox', { name: 'Search people…' })).toBeInTheDocument();
    });

    it('says the view matches nothing — not that there are no people — when a filter is on', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async (input: string) => {
                const path = String(input).split('?')[0] ?? '';
                if (path.endsWith('/people')) return json({ items: [], nextCursor: null });
                if (path.endsWith('/views')) return json([]);
                return json([]);
            }),
        );
        renderAt(`?filter=${encodeFilter({ and: [{ field: 'city', op: 'eq', value: 'Nowhere' }] })}`);
        expect(await screen.findByText('No people match this view')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Clear filters' })).toBeInTheDocument();
    });
});

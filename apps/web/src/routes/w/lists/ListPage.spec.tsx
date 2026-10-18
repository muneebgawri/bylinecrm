import { CAPABILITIES } from '@bylinecrm/shared';
import { MOBILE_QUERY, ThemeProvider, TooltipProvider } from '@bylinecrm/ui';
import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '../../../api/queries';
import type { MembershipSummary } from '../../../api/types';
import { CapabilitiesProvider } from '../../../auth/capabilities';
import { encodeFilter } from '../../../lib/filterParam';
import { CompaniesListPage, PeopleListPage } from './ListPage';

const WS = '11111111-2222-4333-8444-555555555555';
const ME = 'aaaaaaaa-0000-4000-8000-000000000001';

const ACME = { id: 'c1', name: 'Acme Corp' };

const person = (id: string, nameFirst: string, nameLast: string, company: typeof ACME | null = null) => ({
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
    companyId: company?.id ?? null,
    ownerId: ME,
    company,
    owner: { memberId: ME, name: 'Kate Morgan' },
    createdBy: { kind: 'member', id: ME },
    custom: {},
    deletedAt: null,
    createdAt: '2026-10-01T10:00:00.000Z',
    updatedAt: '2026-10-08T10:00:00.000Z',
});

const PEOPLE = [person('p1', 'Dana', 'Reyes', ACME), person('p2', 'Sam', 'Okafor')];
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
    workspaceId: 'w1',
    apiKeyId: null,
    userId: 'u1',
    roleId: 'r1',
    roleName: 'admin',
    recordScope: 'all',
    capabilities: [...CAPABILITIES],
};

interface Call {
    method: string;
    url: string;
    body: unknown;
}

function json(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** A list page as the API answers it (P1-4a): the rows and the size of the whole set. */
const page = (items: unknown[], total = items.length, totalIsExact = true) => ({
    items,
    nextCursor: null,
    total,
    totalIsExact,
});

/** A fetch that answers the list page's routes and records every call. */
function api(calls: Call[], total: { people?: number; exact?: boolean } = {}) {
    return vi.fn(async (input: string, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        const path = url.split('?')[0] ?? '';
        // A saved view's tab count is a one-row read of that view; "My leads" holds one person.
        if (path.endsWith('/people') && url.includes('view=v1') && url.includes('limit=1'))
            return json(page([PEOPLE[0]], 1));
        if (path.endsWith('/people')) return json(page(PEOPLE, total.people ?? PEOPLE.length, total.exact ?? true));
        if (path.endsWith('/people/bulk')) {
            const ids = (calls.at(-1)?.body as { ids: string[] }).ids;
            return json({ results: ids.map((id) => ({ id, ok: true })), succeeded: ids.length, failed: 0 });
        }
        if (path.endsWith('/people/export.csv'))
            return new Response('id\n', { status: 200, headers: { 'Content-Type': 'text/csv' } });
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

function renderAt(search: string, member: MembershipSummary = membership) {
    const router = createMemoryRouter([{ path: '/w/:workspaceId/people', element: <PeopleListPage /> }], {
        initialEntries: [`/w/${WS}/people${search}`],
    });
    render(
        <ThemeProvider>
            <TooltipProvider>
                <QueryClientProvider client={createQueryClient()}>
                    <CapabilitiesProvider membership={member}>
                        <RouterProvider router={router} />
                    </CapabilitiesProvider>
                </QueryClientProvider>
            </TooltipProvider>
        </ThemeProvider>,
    );
    return router;
}

const COMPANY = {
    id: 'c1',
    name: 'Acme Corp',
    domain: 'acme.example',
    employeeCount: 120,
    arr: null,
    address: { street: null, city: null, state: null, country: null, postalCode: null },
    links: { linkedin: null, x: null },
    icp: false,
    position: 0,
    ownerId: ME,
    owner: { memberId: ME, name: 'Kate Morgan' },
    createdBy: { kind: 'member', id: ME },
    custom: {},
    deletedAt: null,
    createdAt: '2026-10-01T10:00:00.000Z',
    updatedAt: '2026-10-08T10:00:00.000Z',
};

function renderCompanies() {
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string) => {
            const path = String(input).split('?')[0] ?? '';
            if (path.endsWith('/companies')) return json(page([COMPANY]));
            if (path.endsWith('/views') || path.endsWith('/custom-fields')) return json([]);
            if (path.endsWith('/members/summary')) return json([{ memberId: ME, name: 'Kate Morgan' }]);
            return json({});
        }),
    );
    const router = createMemoryRouter([{ path: '/w/:workspaceId/companies', element: <CompaniesListPage /> }], {
        initialEntries: [`/w/${WS}/companies`],
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
}

/**
 * jsdom lays nothing out, so every element measures 0×0 and a virtualised list renders no rows.
 * The table's scroll container is given a screen's size here; nothing else reads these.
 */
const layout = {
    offsetWidth: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth'),
    offsetHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight'),
};

/** Answers the phone breakpoint's query as a 375px screen would; every other query "no". */
function asPhone() {
    const real = window.matchMedia;
    vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({
        ...real(query),
        matches: query === MOBILE_QUERY,
    }));
}

describe('People list', () => {
    beforeEach(() => {
        Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 1280 });
        Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 800 });
    });
    afterEach(() => {
        vi.restoreAllMocks();
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
        asPhone();
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
                if (path.endsWith('/people')) return json(page([]));
                if (path.endsWith('/views')) return json([]);
                return json([]);
            }),
        );
        renderAt(`?filter=${encodeFilter({ and: [{ field: 'city', op: 'eq', value: 'Nowhere' }] })}`);
        expect(await screen.findByText('No people match this view')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Clear filters' })).toBeInTheDocument();
    });

    it('shows the total in the footer and a count on every view tab', async () => {
        const calls: Call[] = [];
        vi.stubGlobal('fetch', api(calls));
        renderAt('');
        await screen.findByRole('button', { name: 'Dana Reyes' });
        expect(screen.getByText(/Page 1 of 1 · 2 of 2 people/)).toBeInTheDocument();
        const tabs = screen.getByRole('tablist', { name: 'Views' });
        // The open tab counts from the page's own read; another view from a one-row read of it.
        expect(within(tabs).getByRole('tab', { name: /All people\s*2/ })).toBeInTheDocument();
        expect(await within(tabs).findByRole('tab', { name: /My leads\s*1/ })).toBeInTheDocument();
        expect(calls.filter((c) => c.url.includes('view=v1') && c.url.includes('limit=1'))).toHaveLength(1);
    });

    it('says "10,000+" when the API stops counting', async () => {
        vi.stubGlobal('fetch', api([], { people: 10_000, exact: false }));
        renderAt('');
        await screen.findByRole('button', { name: 'Dana Reyes' });
        expect(screen.getByText(/2 of 10,000\+ people/)).toBeInTheDocument();
    });

    it("names a person's company from the row — no request per company", async () => {
        const calls: Call[] = [];
        vi.stubGlobal('fetch', api(calls));
        renderAt('');
        await screen.findByRole('button', { name: 'Dana Reyes' });
        expect(screen.getByText('Acme Corp')).toBeInTheDocument();
        expect(calls.filter((c) => c.url.includes('/companies'))).toHaveLength(0);
    });

    it('deletes a selection with one bulk request and reports the result', async () => {
        const user = userEvent.setup();
        const calls: Call[] = [];
        vi.stubGlobal('fetch', api(calls));
        renderAt('');
        await screen.findByRole('button', { name: 'Dana Reyes' });
        await user.click(screen.getByRole('checkbox', { name: 'Select Dana Reyes' }));
        await user.click(screen.getByRole('checkbox', { name: 'Select Sam Okafor' }));
        await user.click(screen.getByRole('button', { name: 'Delete' }));
        const confirm = await screen.findByRole('dialog', { name: 'Delete 2 people?' });
        await user.click(within(confirm).getByRole('button', { name: 'Delete' }));

        await waitFor(() => expect(calls.some((c) => c.url.endsWith('/people/bulk'))).toBe(true));
        expect(calls.filter((c) => c.url.endsWith('/people/bulk'))).toEqual([
            { method: 'POST', url: `/api/w/${WS}/people/bulk`, body: { action: 'delete', ids: ['p1', 'p2'] } },
        ]);
        // One request, not one per person.
        expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);
    });

    it('FR-CRMS-UI-1: the columns fill the card — the last column takes the spare width', async () => {
        const calls: Call[] = [];
        vi.stubGlobal('fetch', api(calls));
        renderAt('');
        await screen.findByRole('table');
        const table = screen.getByRole('table');
        // The scroll container measures 1280px here (beforeEach); the default columns add up to less.
        expect(table.style.width).toBe('1280px');
        const headers = within(table).getAllByRole('columnheader');
        const lastData = headers[headers.length - 2] as HTMLElement;
        expect(parseInt(lastData.style.width, 10)).toBeGreaterThan(130);
    });

    it('FR-CRMS-UI-12: the view tabs scroll sideways without a visible scrollbar', async () => {
        const calls: Call[] = [];
        vi.stubGlobal('fetch', api(calls));
        renderAt('');
        expect(await screen.findByRole('tablist', { name: 'Views' })).toHaveClass('scrollbar-hidden');
    });

    it('#192 offers no “Enrol in sequence” at all to a role that cannot enrol', async () => {
        const user = userEvent.setup();
        vi.stubGlobal('fetch', api([]));
        renderAt('', { ...membership, capabilities: CAPABILITIES.filter((c) => c !== 'sequence:enrol') });
        await screen.findByRole('button', { name: 'Dana Reyes' });
        await user.click(screen.getByRole('checkbox', { name: 'Select Dana Reyes' }));
        expect(await screen.findByRole('button', { name: 'Delete' })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Enrol in sequence' })).toBeNull();
    });

    it('#192 offers it to a role that can', async () => {
        const user = userEvent.setup();
        vi.stubGlobal('fetch', api([]));
        renderAt('');
        await screen.findByRole('button', { name: 'Dana Reyes' });
        await user.click(screen.getByRole('checkbox', { name: 'Select Dana Reyes' }));
        expect(await screen.findByRole('button', { name: 'Enrol in sequence' })).toBeEnabled();
    });

    it('exports a selection with one request whose filter names the ids', async () => {
        const user = userEvent.setup();
        const calls: Call[] = [];
        vi.stubGlobal('fetch', api(calls));
        vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} }));
        renderAt('');
        await screen.findByRole('button', { name: 'Dana Reyes' });
        await user.click(screen.getByRole('checkbox', { name: 'Select Sam Okafor' }));
        await user.click(screen.getByRole('button', { name: 'Export selected' }));
        await waitFor(() =>
            expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/people/export.csv'))).toBe(true),
        );
        expect(calls.find((c) => c.method === 'POST' && c.url.endsWith('/people/export.csv'))?.body).toMatchObject({
            filter: { and: [{ field: 'id', op: 'in', value: ['p2'] }] },
        });
    });
});

describe('Companies list', () => {
    beforeEach(() => {
        Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 1280 });
        Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 800 });
    });
    afterEach(() => {
        vi.restoreAllMocks();
        if (layout.offsetWidth) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', layout.offsetWidth);
        if (layout.offsetHeight) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', layout.offsetHeight);
        vi.unstubAllGlobals();
    });

    it("FR-CRMS-UI-1: shows a company's domain once — in the Domain column, not again under the name", async () => {
        renderCompanies();
        const table = await screen.findByRole('table');
        await within(table).findByText('Acme Corp');
        expect(within(table).getAllByText('acme.example')).toHaveLength(1);
    });
});

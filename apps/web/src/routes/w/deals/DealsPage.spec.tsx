import type { Capability } from '@bylinecrm/shared';
import { ThemeProvider, toasts, TooltipProvider } from '@bylinecrm/ui';
import { Toaster } from '@bylinecrm/ui/toaster';
import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient, keys, moveInBoard } from '../../../api/queries';
import type { BoardView, MembershipSummary, OpportunityView, PipelineView, StageView } from '../../../api/types';
import { CapabilitiesProvider } from '../../../auth/capabilities';
import { DealsPage } from './DealsPage';
import { DEALS_VIEW_KEY } from './dealsView';
import { classifyMove, laneAfterKey } from './moveGate';

const WS = 'ws-1';
/** jsdom renders the first board slowly on a cold worker; the assertion is "it appears", not a speed. */
const FIRST_RENDER_MS = 8_000;
const P = 'p-1';

const stage = (id: string, name: string, position: number, kind: StageView['kind'] = 'open'): StageView => ({
    id,
    pipelineId: P,
    name,
    position,
    probability: 10,
    kind,
    daysThreshold: id === 's-contacted' ? 14 : null,
    colour: kind === 'won' ? 'ok' : kind === 'lost' ? 'bad' : 'accent',
});
const STAGES = [
    stage('s-new', 'New', 1),
    stage('s-contacted', 'Contacted', 2),
    stage('s-replied', 'Replied', 3),
    stage('s-won', 'Won', 4, 'won'),
    stage('s-lost', 'Lost', 5, 'lost'),
];
const pipeline: PipelineView = {
    id: P,
    name: 'Sales pipeline',
    isDefault: true,
    position: 1,
    stages: STAGES,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
};
const deal = (id: string, name: string, stageId: string, days = 2): OpportunityView => ({
    id,
    name,
    pipelineId: P,
    stageId,
    stageEnteredAt: '2026-10-07T00:00:00Z',
    daysInStage: days,
    closedAt: null,
    lostReason: null,
    amount: { amountMinor: 1_200_000, currency: 'USD' },
    currency: 'USD',
    closeDate: '2026-10-31',
    probability: null,
    position: 1,
    ownerId: 'm-1',
    pointOfContactId: null,
    companyId: null,
    createdBy: { kind: 'member', id: 'm-1' },
    custom: {},
    deletedAt: null,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
});
const SERIES_B = deal('d-1', 'Series B PR', 's-new');
const board = (): BoardView => ({
    pipeline,
    columns: STAGES.map((s) => {
        const deals =
            s.id === 's-new'
                ? [SERIES_B]
                : s.id === 's-contacted'
                  ? [deal('d-2', 'Product PR', 's-contacted', 21)]
                  : [];
        return {
            stage: s,
            count: deals.length,
            amountMinorByCurrency: deals.length ? { USD: 1_200_000 * deals.length } : {},
            deals,
            hasMore: false,
        };
    }),
});

const ALL: Capability[] = ['deal:read', 'deal:move', 'deal:edit', 'deal:bulk'];
const membership = (capabilities: Capability[]): MembershipSummary => ({
    memberId: 'm-1',
    userId: 'u-1',
    roleId: 'r-1',
    roleName: 'member',
    recordScope: 'all',
    capabilities,
});

/** What the fake API has saved, and every read URL it answered (the board's query string included). */
const savedViews: unknown[] = [];
const boardUrls: string[] = [];

interface MoveCall {
    url: string;
    body: unknown;
}

/**
 * The API, faked with state: a successful move changes what the next board read returns, as the
 * real server would; a refused move changes nothing.
 */
function stubApi(moveResponse: (body: { stageId: string }) => Response) {
    const moves: MoveCall[] = [];
    const placed = new Map<string, string>();
    savedViews.length = 0;
    boardUrls.length = 0;
    const current = (): BoardView => {
        const b = board();
        const all = b.columns.flatMap((c) => c.deals);
        return {
            ...b,
            columns: b.columns.map((c) => {
                const deals = all
                    .map((d) => ({ ...d, stageId: placed.get(d.id) ?? d.stageId }))
                    .filter((d) => d.stageId === c.stage.id);
                return {
                    ...c,
                    deals,
                    count: deals.length,
                    amountMinorByCurrency: deals.length ? { USD: 1_200_000 * deals.length } : {},
                };
            }),
        };
    };
    vi.stubGlobal(
        'fetch',
        vi.fn((url: string, init?: RequestInit) => {
            if (url.includes('/move')) {
                const body = JSON.parse(String(init?.body ?? '{}')) as { stageId: string };
                moves.push({ url, body });
                const response = moveResponse(body);
                const dealId = url.split('/opportunities/')[1]?.split('/')[0];
                if (response.ok && dealId) placed.set(dealId, body.stageId);
                return Promise.resolve(response);
            }
            if (url.includes('/views') && init?.method === 'POST') {
                const body = JSON.parse(String(init.body)) as { name: string; filter: unknown; isShared: boolean };
                const view = {
                    id: 'v-new',
                    object: 'opportunity',
                    icon: null,
                    ownerMemberId: 'm-1',
                    sorts: [],
                    columns: [],
                    groupBy: null,
                    position: 1,
                    createdAt: '',
                    updatedAt: '',
                    ...body,
                };
                savedViews.push(view);
                return Promise.resolve(new Response(JSON.stringify(view), { status: 201 }));
            }
            boardUrls.push(url);
            const body = url.includes('/board')
                ? current()
                : url.includes('/views')
                  ? savedViews
                  : url.endsWith('/rules')
                    ? []
                    : url.endsWith('/members/summary')
                      ? [{ memberId: 'm-1', name: 'Kate Morgan' }]
                      : url.endsWith('/pipelines')
                        ? [pipeline]
                        : {};
            return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
        }),
    );
    return moves;
}

/** Makes `matchMedia` answer as a phone with a finger (or not) for the rest of the test. */
function setPhone(on: boolean) {
    vi.stubGlobal('matchMedia', (query: string) => ({
        matches: on && (query.includes('max-width') || query.includes('pointer: coarse')),
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
    }));
}

function renderPage(capabilities: Capability[] = ALL, entry = `/w/${WS}/deals`) {
    const client = createQueryClient();
    const router = createMemoryRouter([{ path: '/w/:workspaceId/deals', element: <DealsPage /> }], {
        initialEntries: [entry],
    });
    render(
        <QueryClientProvider client={client}>
            <ThemeProvider>
                <TooltipProvider>
                    <CapabilitiesProvider membership={membership(capabilities)}>
                        <RouterProvider router={router} />
                        <Toaster />
                    </CapabilitiesProvider>
                </TooltipProvider>
            </ThemeProvider>
        </QueryClientProvider>,
    );
    return { client, router };
}

const card = async (name: string) =>
    (await screen.findByText(name, { selector: 'h3' }, { timeout: FIRST_RENDER_MS })).closest(
        '[data-deal-id]',
    ) as HTMLElement;
const laneOf = (name: string) =>
    screen
        .getByRole('region', { name: /pipeline board/i })
        .querySelector(`section[aria-label^="${name},"]`) as HTMLElement;

describe('moveGate', () => {
    it('classifies forward, backward, closing and no-op moves', () => {
        expect(classifyMove(STAGES, 's-new', 's-new')).toEqual({ kind: 'same' });
        expect(classifyMove(STAGES, 's-new', 's-replied')).toEqual({ kind: 'forward', closes: null });
        expect(classifyMove(STAGES, 's-replied', 's-new')).toEqual({ kind: 'backward', closes: null });
        expect(classifyMove(STAGES, 's-new', 's-won')).toEqual({ kind: 'forward', closes: 'won' });
        expect(classifyMove(STAGES, 's-new', 'nope')).toEqual({ kind: 'unknown' });
    });

    it('clamps a keyboard move to the lanes that exist', () => {
        expect(laneAfterKey(0, 'ArrowLeft', 5)).toBe(0);
        expect(laneAfterKey(4, 'ArrowRight', 5)).toBe(4);
        expect(laneAfterKey(1, 'ArrowRight', 5)).toBe(2);
    });
});

describe('moveInBoard', () => {
    it('moves the card and leaves the API’s counts and sums alone', () => {
        const next = moveInBoard(board(), 'd-1', 's-replied');
        expect(next.columns[0]?.deals).toHaveLength(0);
        expect(next.columns[2]?.deals.map((d) => d.id)).toEqual(['d-1']);
        expect(next.columns[0]?.count).toBe(1);
        expect(next.columns[0]?.amountMinorByCurrency).toEqual({ USD: 1_200_000 });
    });
});

describe('DealsPage', { timeout: 20_000 }, () => {
    // The rendering choice persists per person; each test starts from the default (the board).
    beforeEach(() => {
        toasts.clear();
        localStorage.clear();
    });
    afterEach(() => {
        vi.unstubAllGlobals();
        toasts.clear();
    });
    beforeEach(() => setPhone(false));

    it('board and list read one query key — one result set, two renderings', async () => {
        stubApi(() => new Response('{}', { status: 200 }));
        const { client } = renderPage();
        await card('Series B PR');
        const key = keys.board(WS, P, {});
        expect(client.getQueryData(key)).toBeDefined();
        const user = userEvent.setup();
        await user.click(screen.getByRole('radio', { name: 'List' }));
        expect(await screen.findByRole('columnheader', { name: /Deal/ })).toBeInTheDocument();
        expect(screen.getByText('Series B PR')).toBeInTheDocument();
        // The list did not ask for anything new: the same cache entry is the only board query.
        expect(client.getQueryCache().findAll({ queryKey: ['w', WS, 'pipelines', P, 'board'] })).toHaveLength(1);
    });

    it('moves a deal with the keyboard: Space picks up, → chooses, Space drops, announced', async () => {
        const moves = stubApi(
            (body) =>
                new Response(
                    JSON.stringify({ deal: { ...SERIES_B, stageId: body.stageId }, rulesThatMayMoveItForward: [] }),
                    {
                        status: 200,
                    },
                ),
        );
        renderPage();
        const c = await card('Series B PR');
        c.focus();
        fireEvent.keyDown(c, { key: ' ' });
        expect(screen.getByText(/picked up from New/)).toBeInTheDocument();
        fireEvent.keyDown(c, { key: 'ArrowRight' });
        expect(screen.getByText(/Series B PR, Contacted, position 1 of 2/)).toBeInTheDocument();
        fireEvent.keyDown(c, { key: ' ' });
        await waitFor(() => expect(moves).toHaveLength(1));
        expect(moves[0]?.body).toEqual({ stageId: 's-contacted' });
        // The card is in its new lane — painted before the answer, kept after it.
        await waitFor(() => expect(within(laneOf('Contacted')).getByText('Series B PR')).toBeInTheDocument());
        expect(within(laneOf('New')).queryByText('Series B PR')).not.toBeInTheDocument();
    });

    it('Escape cancels a keyboard pick-up and sends nothing', async () => {
        const moves = stubApi(() => new Response('{}', { status: 200 }));
        renderPage();
        const c = await card('Series B PR');
        fireEvent.keyDown(c, { key: ' ' });
        fireEvent.keyDown(c, { key: 'ArrowRight' });
        fireEvent.keyDown(c, { key: 'Escape' });
        expect(screen.getByText('Series B PR put back in New.')).toBeInTheDocument();
        expect(moves).toHaveLength(0);
    });

    it('snaps back on a 409 and shows the server’s reason in a toast', async () => {
        stubApi(
            () =>
                new Response(
                    JSON.stringify({ statusCode: 409, error: 'Conflict', message: 'You no longer own this deal' }),
                    {
                        status: 409,
                    },
                ),
        );
        renderPage();
        const c = await card('Series B PR');
        fireEvent.keyDown(c, { key: ' ' });
        fireEvent.keyDown(c, { key: 'ArrowRight' });
        fireEvent.keyDown(c, { key: ' ' });
        expect(await screen.findByText('Series B PR was not moved')).toBeInTheDocument();
        expect(screen.getByText('You no longer own this deal')).toBeInTheDocument();
        await waitFor(() => expect(within(laneOf('New')).getByText('Series B PR')).toBeInTheDocument());
    });

    it('a won/lost target opens the close dialog first; cancel moves nothing, a reason is required for lost', async () => {
        const moves = stubApi(
            (body) =>
                new Response(
                    JSON.stringify({ deal: { ...SERIES_B, stageId: body.stageId }, rulesThatMayMoveItForward: [] }),
                    {
                        status: 200,
                    },
                ),
        );
        const user = userEvent.setup();
        renderPage();
        const c = await card('Series B PR');
        fireEvent.keyDown(c, { key: ' ' });
        for (let i = 0; i < 4; i++) fireEvent.keyDown(c, { key: 'ArrowRight' });
        fireEvent.keyDown(c, { key: ' ' });
        expect(await screen.findByRole('dialog', { name: /as lost/ })).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(moves).toHaveLength(0);

        fireEvent.keyDown(c, { key: ' ' });
        for (let i = 0; i < 4; i++) fireEvent.keyDown(c, { key: 'ArrowRight' });
        fireEvent.keyDown(c, { key: ' ' });
        await screen.findByRole('dialog', { name: /as lost/ });
        await user.click(screen.getByRole('button', { name: 'Mark as lost' }));
        expect(screen.getByText(/Say why it was lost/)).toBeInTheDocument();
        expect(moves).toHaveLength(0);
        await user.type(screen.getByRole('textbox', { name: /Lost reason/ }), 'Went with a competitor');
        await user.click(screen.getByRole('button', { name: 'Mark as lost' }));
        await waitFor(() => expect(moves).toHaveLength(1));
        expect(moves[0]?.body).toEqual({ stageId: 's-lost', close: { lostReason: 'Went with a competitor' } });
    });

    it('without deal:move cards cannot be picked up, and New deal is absent without deal:edit', async () => {
        const moves = stubApi(() => new Response('{}', { status: 200 }));
        renderPage(['deal:read']);
        const c = await card('Series B PR');
        fireEvent.keyDown(c, { key: ' ' });
        expect(screen.queryByText(/picked up/)).not.toBeInTheDocument();
        expect(moves).toHaveLength(0);
        expect(screen.queryByRole('button', { name: /New deal/ })).not.toBeInTheDocument();
    });

    it('formats the API’s per-stage sums and marks a card past its stage threshold', async () => {
        stubApi(() => new Response('{}', { status: 200 }));
        renderPage();
        await card('Product PR');
        // The lane's sum (from the API) and the card's amount, through the one formatter's compact form.
        expect(within(laneOf('New')).getAllByText('$12K')).toHaveLength(2);
        expect(within(laneOf('Contacted')).getByText('⚠ Quiet')).toBeInTheDocument();
    });

    it('adds a filter chip and sends it to the board as base64url', async () => {
        stubApi(() => new Response('{}', { status: 200 }));
        const user = userEvent.setup();
        renderPage();
        await card('Series B PR');
        await user.click(screen.getByRole('button', { name: 'Filter' }));
        const dialog = await screen.findByRole('dialog', { name: 'Add a filter' });
        await user.click(within(dialog).getByRole('combobox', { name: 'Condition' }));
        await user.click(await screen.findByRole('option', { name: 'contains' }));
        await user.type(within(dialog).getByRole('textbox', { name: 'Value' }), 'PR');
        await user.click(within(dialog).getByRole('button', { name: 'Add filter' }));
        expect(await screen.findByText('Name contains PR')).toBeInTheDocument();
        await waitFor(() => expect(boardUrls.some((u) => u.includes('/board') && u.includes('filter='))).toBe(true));
        const sent = boardUrls.filter((u) => u.includes('filter=')).at(-1) ?? '';
        const raw = new URL(sent, 'http://x').searchParams.get('filter') ?? '';
        expect(JSON.parse(Buffer.from(raw, 'base64url').toString())).toEqual({
            and: [{ field: 'name', op: 'contains', value: 'PR' }],
        });
    });

    it('saves the current filter as a view and drives the board by it', async () => {
        stubApi(() => new Response('{}', { status: 200 }));
        const user = userEvent.setup();
        const filter = Buffer.from(JSON.stringify({ and: [{ field: 'closeDate', op: 'is_null' }] })).toString(
            'base64url',
        );
        renderPage([...ALL, 'view:save'], `/w/${WS}/deals?filter=${filter}`);
        await card('Series B PR');
        await user.click(screen.getByRole('button', { name: /Saved view: All deals/ }));
        await user.click(await screen.findByRole('menuitem', { name: /Save current filters/ }));
        await user.type(await screen.findByRole('textbox', { name: /Name/ }), 'Open dated');
        await user.click(screen.getByRole('button', { name: 'Save view' }));
        expect(await screen.findByText('Open dated saved')).toBeInTheDocument();
        expect(savedViews.at(-1)).toMatchObject({
            name: 'Open dated',
            filter: { and: [{ field: 'closeDate', op: 'is_null' }] },
        });
        await waitFor(() => expect(boardUrls.some((u) => u.includes('/board') && u.includes('view=v-new'))).toBe(true));
    });

    it('removing a chip removes the filter from the query', async () => {
        stubApi(() => new Response('{}', { status: 200 }));
        const user = userEvent.setup();
        const filter = Buffer.from(JSON.stringify({ and: [{ field: 'closeDate', op: 'is_null' }] })).toString(
            'base64url',
        );
        renderPage(ALL, `/w/${WS}/deals?filter=${filter}`);
        await card('Series B PR');
        await user.click(screen.getByRole('button', { name: 'Remove filter: Close date is empty' }));
        await waitFor(() => expect(boardUrls.at(-1)).not.toContain('filter='));
    });

    it('offers no Owner filter to an own-scoped member', async () => {
        stubApi(() => new Response('{}', { status: 200 }));
        const user = userEvent.setup();
        const client = createQueryClient();
        const router = createMemoryRouter([{ path: '/w/:workspaceId/deals', element: <DealsPage /> }], {
            initialEntries: [`/w/${WS}/deals`],
        });
        render(
            <QueryClientProvider client={client}>
                <ThemeProvider>
                    <TooltipProvider>
                        <CapabilitiesProvider membership={{ ...membership(ALL), recordScope: 'own' }}>
                            <RouterProvider router={router} />
                        </CapabilitiesProvider>
                    </TooltipProvider>
                </ThemeProvider>
            </QueryClientProvider>,
        );
        await card('Series B PR');
        await user.click(screen.getByRole('button', { name: 'Filter' }));
        const dialog = await screen.findByRole('dialog', { name: 'Add a filter' });
        await user.click(within(dialog).getByRole('combobox', { name: 'Field' }));
        expect(screen.queryByRole('option', { name: 'Owner' })).not.toBeInTheDocument();
        expect(screen.getByRole('option', { name: 'Amount' })).toBeInTheDocument();
    });

    it('opens the deal’s drawer from a click and from Enter', async () => {
        stubApi(() => new Response('{}', { status: 200 }));
        const { router } = renderPage();
        const c = await card('Series B PR');
        fireEvent.click(c);
        expect(router.state.location.search).toContain('open=opportunity%3Ad-1');
        fireEvent.keyDown(await card('Product PR'), { key: 'Enter' });
        expect(router.state.location.search).toContain('open=opportunity%3Ad-2');
    });

    it('on a phone: one stage per screen with a stage chip row, and "Move to stage" instead of drag', async () => {
        setPhone(true);
        const moves = stubApi(
            (body) =>
                new Response(
                    JSON.stringify({ deal: { ...SERIES_B, stageId: body.stageId }, rulesThatMayMoveItForward: [] }),
                    {
                        status: 200,
                    },
                ),
        );
        const user = userEvent.setup();
        renderPage();
        await card('Series B PR');
        expect(screen.getByRole('region', { name: /one stage per screen/ })).toBeInTheDocument();
        const chips = within(screen.getByRole('navigation', { name: 'Stages' })).getAllByRole('button');
        expect(chips.map((b) => b.textContent)).toEqual(['New1', 'Contacted1', 'Replied0', 'Won0', 'Lost0']);
        expect(chips[0]).toHaveAttribute('aria-current', 'true');
        await user.click(screen.getByRole('button', { name: /Move to stage: Series B PR/ }));
        const sheet = await screen.findByRole('dialog', { name: 'Move “Series B PR”' });
        expect(within(sheet).getByRole('button', { name: /New/ })).toBeDisabled();
        await user.click(within(sheet).getByRole('button', { name: 'Replied' }));
        await waitFor(() => expect(moves).toHaveLength(1));
        expect(moves[0]?.body).toEqual({ stageId: 's-replied' });
    });

    it('on a phone the list is stacked cards with 44px selection and a stage select', async () => {
        setPhone(true);
        stubApi(() => new Response('{}', { status: 200 }));
        renderPage(ALL, `/w/${WS}/deals?show=list`);
        const cards = await screen.findByRole('list', { name: '2 deals' });
        expect(within(cards).getAllByRole('listitem')).toHaveLength(2);
        expect(within(cards).queryByRole('table')).not.toBeInTheDocument();
        const select = within(cards).getByRole('checkbox', { name: 'Select Series B PR' });
        expect(select.className).toContain('size-touch');
        expect(within(cards).getByRole('combobox', { name: 'Stage of Series B PR' })).toBeInTheDocument();
    });

    it('shows loading, not a refusal, while the member’s standing is unknown', async () => {
        stubApi(() => new Response('{}', { status: 200 }));
        const router = createMemoryRouter([{ path: '/w/:workspaceId/deals', element: <DealsPage /> }], {
            initialEntries: [`/w/${WS}/deals`],
        });
        render(
            <QueryClientProvider client={createQueryClient()}>
                <ThemeProvider>
                    <TooltipProvider>
                        <CapabilitiesProvider membership={null}>
                            <RouterProvider router={router} />
                        </CapabilitiesProvider>
                    </TooltipProvider>
                </ThemeProvider>
            </QueryClientProvider>,
        );
        expect(await screen.findByLabelText('Loading deals')).toBeInTheDocument();
        expect(screen.queryByText('You cannot see deals')).not.toBeInTheDocument();
    });

    it('remembers the rendering the person chose', async () => {
        stubApi(() => new Response('{}', { status: 200 }));
        const user = userEvent.setup();
        renderPage();
        await card('Series B PR');
        await user.click(screen.getByRole('radio', { name: 'List' }));
        expect(localStorage.getItem(DEALS_VIEW_KEY)).toBe('list');
    });
});

import { screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DealFeedItemView } from '../../../api/types';
import { json, renderAt, route, stubApi } from '../settings/settingsTestKit';
import { HomePage } from './HomePage';

const WS = 'ws-1';
const NOW = new Date('2026-10-18T10:00:00Z');

const entry = (over: Partial<DealFeedItemView>): DealFeedItemView => ({
    id: 'e-1',
    kind: 'created',
    happenedAt: '2026-10-18T09:00:00Z',
    actor: { kind: 'member', member: { id: 'm-2', name: 'Sara Khan' } },
    deal: {
        id: 'd-1',
        name: 'Acme retainer',
        amount: { amountMinor: 240_000, currency: 'USD' },
        owner: { id: 'm-2', name: 'Sara Khan' },
        canOpen: false,
    },
    fromStage: null,
    toStage: null,
    ...over,
});

const FEED: DealFeedItemView[] = [
    entry({ id: 'e-1', kind: 'stage', fromStage: 'Contacted', toStage: 'Proposal' }),
    entry({
        id: 'e-3',
        kind: 'stage',
        actor: { kind: 'rule', member: null },
        happenedAt: '2026-10-18T08:00:00Z',
        toStage: 'Won',
    }),
    entry({
        id: 'e-2',
        kind: 'won',
        happenedAt: '2026-10-17T15:00:00Z',
        actor: { kind: 'member', member: { id: 'm-1', name: 'Me Myself' } },
        deal: {
            id: 'd-2',
            name: 'Brightline launch',
            amount: null,
            owner: { id: 'm-1', name: 'Me Myself' },
            canOpen: true,
        },
    }),
];

const home = () => renderAt([route('/w/:workspaceId/home', <HomePage />)], `/w/${WS}/home`, ['record:read']);

describe('live deal feed on the dashboard', () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(NOW);
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('tells what the team did, by day; a teammate’s deal is named, only an openable one links', async () => {
        stubApi([
            (r) => (r.method === 'GET' && r.url.endsWith('/deal-feed') ? json({ items: FEED }) : undefined),
            (r) => (r.method === 'GET' && r.url.endsWith('/my-tasks') ? json([]) : undefined),
        ]);
        home();
        const feed = await screen.findByRole('region', { name: 'Latest deal activity' });
        const today = await within(feed).findByRole('region', { name: 'Today' });
        expect(within(today).getByText('Sara Khan')).toBeInTheDocument();
        expect(within(today).getByText('Proposal')).toBeInTheDocument();
        expect(within(today).queryByRole('link', { name: 'Acme retainer' })).toBeNull();
        expect(within(today).getByText('Automation')).toBeInTheDocument();
        const yesterday = within(feed).getByRole('region', { name: 'Yesterday' });
        expect(within(yesterday).getByRole('link', { name: 'Brightline launch' })).toHaveAttribute(
            'href',
            `/w/${WS}/deals/d-2`,
        );
        expect(within(yesterday).getByText('Won')).toBeInTheDocument();
    });

    it('a feed that cannot be read says so and leaves the rest of the dashboard standing', async () => {
        stubApi([(r) => (r.method === 'GET' && r.url.endsWith('/my-tasks') ? json([]) : undefined)]);
        home();
        expect(await screen.findByText('Deal activity is unavailable')).toBeInTheDocument();
        expect(screen.getByText('Paused')).toBeInTheDocument();
        expect(screen.getByRole('heading', { name: 'My tasks' })).toBeInTheDocument();
    });
});

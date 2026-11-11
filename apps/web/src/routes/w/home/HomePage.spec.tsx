import type { Capability } from '@bylinecrm/shared';
import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { json, renderAt, route, stubApi } from '../settings/settingsTestKit';
import { HomePage } from './HomePage';

const WS = 'ws-1';
/** The dashboard makes many reads; a cold worker under load takes a while to settle them all. */
const WAIT = { timeout: 15_000 };
const empty = { count: 0, countIsExact: true, nextCursor: null, items: [] };
const day = {
    member: { memberId: 'm-1', name: 'Kate Morgan', leftAt: null },
    date: '2026-11-11',
    windows: { replyDays: 30, newLeadDays: 14, stalledDays: 21 },
    replies: { ...empty, count: 2 },
    followUps: { ...empty, count: 3 },
    newLeads: empty,
    tasks: { ...empty, count: 1 },
    stalled: empty,
};

const pipeline = { id: 'pl-1', name: 'Sales', isDefault: true, position: 0, stages: [], createdAt: '', updatedAt: '' };
const board = { pipeline, columns: [] };

/** Every read the dashboard makes, answered with nothing to show; the work list with its counts. */
const home = (capabilities: Capability[]) => {
    stubApi([
        (r) => (r.method === 'GET' && /\/today(\?|$)/.test(r.url) ? json(day) : undefined),
        (r) =>
            r.method === 'GET' && r.url.endsWith('/me/profile')
                ? json({ displayName: 'Kate', email: 'k@x.test' })
                : undefined,
        (r) => (r.method === 'GET' && r.url.endsWith('/deal-feed') ? json({ items: [] }) : undefined),
        // One empty default pipeline: the welcome's sentence needs a board to speak of.
        (r) => (r.method === 'GET' && r.url.includes('/pipelines/pl-1/board') ? json(board) : undefined),
        (r) => (r.method === 'GET' && r.url.endsWith('/pipelines') ? json([pipeline]) : undefined),
        (r) => (r.method === 'GET' && /\/(members|members\/summary)$/.test(r.url) ? json([]) : undefined),
        (r) => (r.method === 'POST' && r.url.includes('/count') ? json({ total: 0, totalIsExact: true }) : undefined),
    ]);
    return renderAt([route('/w/:workspaceId/home', <HomePage />)], `/w/${WS}/home`, capabilities);
};

describe('#360 the dashboard by role', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('welcomes an account manager with their day’s work and the feed, and no pipeline cards', async () => {
        home(['record:read', 'record:write', 'task:write']);
        expect(await screen.findByRole('heading', { name: 'Welcome back, Kate' }, WAIT)).toBeInTheDocument();
        // The welcome counts the work list: 2 + 3 + 1.
        expect(await screen.findByText('6', {}, WAIT)).toBeInTheDocument();
        expect(await screen.findByRole('region', { name: 'Replies waiting' }, WAIT)).toBeInTheDocument();
        expect(screen.getByRole('heading', { name: 'Live deals' })).toBeInTheDocument();
        expect(screen.queryByText('Pipeline pulse')).toBeNull();
        expect(screen.queryByRole('combobox', { name: 'Whose day' })).toBeNull();
    });

    it('shows an admin the pipeline first, then the work list with a member picker', async () => {
        home(['record:read', 'workspace:admin']);
        const pulse = await screen.findByText('Pipeline pulse', {}, WAIT);
        expect(await screen.findByRole('combobox', { name: 'Whose day' }, WAIT)).toBeInTheDocument();
        const work = await screen.findByRole('region', { name: 'Replies waiting' }, WAIT);
        expect(pulse.compareDocumentPosition(work) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
});

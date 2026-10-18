import type { Capability } from '@bylinecrm/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MyTaskView } from '../../../api/types';
import { json, renderAt, route, stubApi } from '../settings/settingsTestKit';
import { HomePage } from './HomePage';

const WS = 'ws-1';
const NOW = new Date('2026-10-18T10:00:00Z');

const task = (over: Partial<MyTaskView>): MyTaskView => ({
    id: 't-1',
    title: 'Task',
    status: 'todo',
    dueAt: null,
    targets: [{ type: 'person', id: 'p-1', label: 'Pat Prospect' }],
    ...over,
});

const MINE: MyTaskView[] = [
    task({ id: 't-1', title: 'Call if no reply', dueAt: '2026-10-16T09:00:00Z' }),
    task({ id: 't-2', title: 'Send the deck', dueAt: '2026-10-18T15:00:00Z' }),
    task({
        id: 't-3',
        title: 'Check in after launch',
        dueAt: '2026-10-25T09:00:00Z',
        targets: [{ type: 'opportunity', id: 'd-1', label: 'Acme retainer' }],
    }),
    task({ id: 't-4', title: 'Someday', dueAt: null }),
];

const home = (capabilities: Capability[]) =>
    renderAt([route('/w/:workspaceId/home', <HomePage />)], `/w/${WS}/home`, capabilities);

describe('#192 My tasks on the dashboard', () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(NOW);
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('groups my open tasks — overdue, due today, upcoming, no date — each linking to what it is about', async () => {
        stubApi([(r) => (r.method === 'GET' && r.url.endsWith('/my-tasks') ? json(MINE) : undefined)]);
        home(['record:read', 'task:write']);
        const section = (name: string) => screen.getByRole('region', { name });
        expect(await screen.findByRole('heading', { name: 'My tasks' })).toBeInTheDocument();
        await screen.findByRole('region', { name: 'Overdue' });
        expect(within(section('Overdue')).getByText('Call if no reply')).toBeInTheDocument();
        expect(within(section('Due today')).getByText('Send the deck')).toBeInTheDocument();
        expect(within(section('Upcoming')).getByText('Check in after launch')).toBeInTheDocument();
        expect(within(section('No due date')).getByText('Someday')).toBeInTheDocument();
        expect(within(section('Overdue')).getByRole('link', { name: 'Pat Prospect' })).toHaveAttribute(
            'href',
            `/w/${WS}/people/p-1`,
        );
        expect(within(section('Upcoming')).getByRole('link', { name: 'Acme retainer' })).toHaveAttribute(
            'href',
            `/w/${WS}/deals/d-1`,
        );
    });

    it('completes a task in place', async () => {
        const seen = stubApi([
            (r) => (r.method === 'GET' && r.url.endsWith('/my-tasks') ? json(MINE) : undefined),
            (r) => (r.method === 'PATCH' && r.url.endsWith('/tasks/t-2') ? json({ id: 't-2' }) : undefined),
        ]);
        home(['record:read', 'task:write']);
        await userEvent.click(await screen.findByRole('checkbox', { name: 'Complete “Send the deck”' }));
        await waitFor(() => expect(seen.find((r) => r.method === 'PATCH')?.body).toEqual({ status: 'done' }));
    });

    it('says when there is nothing to do, and offers no completing without task:write', async () => {
        stubApi([(r) => (r.method === 'GET' && r.url.endsWith('/my-tasks') ? json([MINE[1]]) : undefined)]);
        const { unmount } = home(['record:read']);
        expect(await screen.findByText('Send the deck')).toBeInTheDocument();
        expect(screen.queryByRole('checkbox')).toBeNull();
        unmount();
        stubApi([(r) => (r.method === 'GET' && r.url.endsWith('/my-tasks') ? json([]) : undefined)]);
        home(['record:read', 'task:write']);
        expect(await screen.findByText('Nothing assigned to you')).toBeInTheDocument();
    });
});

import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NotificationsView } from '../api/types';
import { json, renderAt, route, stubApi } from '../routes/w/settings/settingsTestKit';
import { NotificationsBell } from './NotificationsBell';

const WS = 'ws-1';

const INBOX: NotificationsView = {
    unread: 1,
    items: [
        {
            id: 'n-1',
            kind: 'task_assigned',
            createdAt: '2026-10-18T09:00:00Z',
            readAt: null,
            task: {
                id: 't-1',
                title: 'Call if no reply',
                dueAt: '2026-10-18T09:00:00Z',
                targets: [{ type: 'person', id: 'p-1', label: 'Pat Prospect' }],
            },
        },
        {
            id: 'n-2',
            kind: 'task_due',
            createdAt: '2026-10-17T09:00:00Z',
            readAt: '2026-10-17T10:00:00Z',
            task: {
                id: 't-2',
                title: 'Send the deck',
                dueAt: '2026-10-17T09:00:00Z',
                targets: [{ type: 'company', id: 'c-1', label: 'Acme' }],
            },
        },
    ],
};

const bell = () =>
    renderAt(
        [
            route('/w/:workspaceId/home', <NotificationsBell workspaceId={WS} />),
            route('/w/:workspaceId/people/:personId', <p>person page</p>),
        ],
        `/w/${WS}/home`,
        ['record:read'],
    );

describe('#192 the bell: a member’s task notifications', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('says how many are unread, lists them with what they are about, and opens the record, marking it read', async () => {
        const seen = stubApi([
            (r) => (r.method === 'GET' && r.url.endsWith('/notifications') ? json(INBOX) : undefined),
            (r) =>
                r.method === 'GET' && r.url.endsWith('/notification-settings') ? json({ taskDigest: true }) : undefined,
            (r) =>
                r.method === 'POST' && r.url.endsWith('/notifications/read')
                    ? new Response(null, { status: 204 })
                    : undefined,
        ]);
        bell();
        await userEvent.click(await screen.findByRole('button', { name: 'Notifications, 1 unread' }));
        const panel = await screen.findByRole('dialog', { name: 'Notifications' });
        expect(within(panel).getByText('Assigned to you')).toBeInTheDocument();
        expect(within(panel).getByText('Due')).toBeInTheDocument();
        await userEvent.click(within(panel).getByRole('link', { name: /Call if no reply.*Pat Prospect/ }));
        expect(await screen.findByText('person page')).toBeInTheDocument();
        await waitFor(() => expect(seen.find((r) => r.method === 'POST')?.body).toEqual({ ids: ['n-1'] }));
    });

    it('marks all read, and shows no unread count when there is none', async () => {
        const seen = stubApi([
            (r) => (r.method === 'GET' && r.url.endsWith('/notifications') ? json(INBOX) : undefined),
            (r) =>
                r.method === 'GET' && r.url.endsWith('/notification-settings') ? json({ taskDigest: true }) : undefined,
            (r) =>
                r.method === 'POST' && r.url.endsWith('/notifications/read')
                    ? new Response(null, { status: 204 })
                    : undefined,
        ]);
        bell();
        await userEvent.click(await screen.findByRole('button', { name: 'Notifications, 1 unread' }));
        await userEvent.click(await screen.findByRole('button', { name: 'Mark all read' }));
        await waitFor(() => expect(seen.find((r) => r.method === 'POST')?.body).toEqual({}));
    });

    it('turns the daily email digest off', async () => {
        const seen = stubApi([
            (r) =>
                r.method === 'GET' && r.url.endsWith('/notifications') ? json({ unread: 0, items: [] }) : undefined,
            (r) =>
                r.method === 'GET' && r.url.endsWith('/notification-settings') ? json({ taskDigest: true }) : undefined,
            (r) =>
                r.method === 'PUT' && r.url.endsWith('/notification-settings')
                    ? json({ taskDigest: false })
                    : undefined,
        ]);
        bell();
        await userEvent.click(await screen.findByRole('button', { name: 'Notifications' }));
        expect(await screen.findByText('Nothing new')).toBeInTheDocument();
        const digest = await screen.findByRole('switch', { name: /daily email of tasks due/i });
        expect(digest).toBeChecked();
        await userEvent.click(digest);
        await waitFor(() => expect(seen.find((r) => r.method === 'PUT')?.body).toEqual({ taskDigest: false }));
    });
});
